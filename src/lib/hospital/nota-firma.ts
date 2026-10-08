// ─────────────────────────────────────────────────────────────────────────────
// Firma del autor sobre una nota clínica (firma electrónica simple).
//
// La nota ya trae el sello del sistema (`hash` + `selloAt`, NOM-024). Aquí el
// autor añade su trazo autógrafo digital: firmaHash = sha256(trazo | hash de
// la nota | AUTOR | autorNombre | fecha), con IP y user agent, la misma cadena
// que las firmas de documentos (firmas.ts). Sólo el autor firma, una sola vez,
// sobre una nota vigente (no sustituida) cuyo sello coincide con su contenido.
// ─────────────────────────────────────────────────────────────────────────────

import type { HospNota, Prisma, PrismaClient } from "@prisma/client";
import { HospitalError } from "./errores";
import { hashFirma, validarImagenFirma } from "./firmas";
import { verificarHashNota } from "./notas";

type Db = PrismaClient | Prisma.TransactionClient;

type NotaFirmable = Pick<HospNota, "id" | "autorUserId" | "hash" | "firmadaAt" | "tipo"> & { reemplazadaPor?: { id: string } | null; hashVerificado?: boolean | null };

/** Por qué este usuario no puede firmar la nota, o null si puede. */
export function motivoNoFirmable(n: NotaFirmable, userId: string): string | null {
  if (n.tipo === "MEDICAMENTO_APLICADO") return "La aplicación de medicamento la firma el sistema; no lleva firma autógrafa.";
  if (!n.hash) return "La nota no tiene sello del sistema; no se puede firmar.";
  if (n.hashVerificado === false) return "El contenido de la nota no coincide con su sello; no se puede firmar.";
  if (n.firmadaAt) return "La nota ya está firmada.";
  if (n.reemplazadaPor) return "La nota fue sustituida por una corrección; firma la corrección.";
  if (!n.autorUserId || n.autorUserId !== userId) return "Sólo quien escribió la nota puede firmarla.";
  return null;
}

export function hashFirmaNota(a: { imagen: string; hashNota: string; autorNombre: string; at: Date }): string {
  return hashFirma({ imagen: a.imagen, hashDocumento: a.hashNota, rol: "AUTOR", nombre: a.autorNombre, at: a.at });
}

/** true/false si la firma corresponde a la nota y al trazo; null sin firma. */
export function verificarFirmaNota(n: Pick<HospNota, "firmaImagen" | "firmaHash" | "firmadaAt" | "hash" | "autorNombre">): boolean | null {
  if (!n.firmaImagen || !n.firmaHash || !n.firmadaAt || !n.hash) return null;
  return hashFirmaNota({ imagen: n.firmaImagen, hashNota: n.hash, autorNombre: n.autorNombre, at: n.firmadaAt }) === n.firmaHash;
}

export async function firmarNota(
  db: Db,
  a: { episodioId: string; notaId: string; imagen: string; ip: string | null; userAgent: string | null; userId: string; ahora?: Date }
) {
  const img = validarImagenFirma(a.imagen);
  if (!img.ok) throw new HospitalError(400, img.error);
  const nota = await db.hospNota.findUnique({ where: { id: a.notaId }, include: { reemplazadaPor: { select: { id: true } } } });
  if (!nota || nota.episodioId !== a.episodioId) throw new HospitalError(404, "Nota no encontrada");
  const motivo = motivoNoFirmable({ ...nota, hashVerificado: verificarHashNota(nota) }, a.userId);
  if (motivo) throw new HospitalError(motivo.startsWith("Sólo") ? 403 : 409, motivo);

  const at = a.ahora ?? new Date();
  const firmaHash = hashFirmaNota({ imagen: a.imagen, hashNota: nota.hash!, autorNombre: nota.autorNombre, at });
  // Condicional: dos firmas simultáneas no se pisan.
  const r = await db.hospNota.updateMany({
    where: { id: nota.id, firmadaAt: null },
    data: { firmaImagen: a.imagen, firmaHash, firmadaAt: at, firmaIp: a.ip, firmaUserAgent: a.userAgent?.slice(0, 400) ?? null },
  });
  if (r.count === 0) throw new HospitalError(409, "La nota ya está firmada.");
  return { id: nota.id, firmaHash, firmadaAt: at, hashNota: nota.hash! };
}
