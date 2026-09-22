// ─────────────────────────────────────────────────────────────────────────────
// Persistencia del monitoreo de cumplimiento. Guarda un ComplianceSnapshot solo
// cuando el contenido cambió (hash), reconstruye el resultado anterior para
// detectar el cambio, y materializa los Hallazgos en FiscalHallazgo.
//
// El acuse PDF se guarda ENTERO en la base (acusePdf), como el de las
// declaraciones. `acuseUrl` queda para la referencia legado al archivo en
// Syntage; `asegurarAcusePdf` la convierte en bytes cuando hay con qué bajarla.
// ─────────────────────────────────────────────────────────────────────────────

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { evaluarCambioCumplimiento, hashContenido } from "./diff";
import type { ComplianceResult, CsfPerfil, ResultadoOpinion, TipoCumplimiento } from "./types";

type SnapshotRow = {
  tipo: string;
  resultado: string;
  motivos: string[];
  perfil: Prisma.JsonValue;
  fetchedAt: Date;
};

/** Reconstruye un ComplianceResult desde el snapshot guardado (para el diff). */
function reconstruir(snap: SnapshotRow): ComplianceResult {
  const fetchedAt = snap.fetchedAt.toISOString();
  if (snap.tipo === "CSF") {
    return { tipo: "CSF", perfil: (snap.perfil as unknown as CsfPerfil), fetchedAt };
  }
  return {
    tipo: snap.tipo as "SAT_OPINION" | "IMSS_OPINION",
    resultado: snap.resultado as ResultadoOpinion,
    motivos: snap.motivos,
    fetchedAt,
  };
}

/** Nombre de archivo del acuse guardado: «opinion-32d-2026-09-22.pdf». */
export function nombreAcuse(tipo: TipoCumplimiento | string, fecha = new Date()): string {
  const base = tipo === "SAT_OPINION" ? "opinion-32d" : tipo === "IMSS_OPINION" ? "opinion-imss" : tipo.toLowerCase();
  return `${base}-${fecha.toISOString().slice(0, 10)}.pdf`;
}

/** Bytes de una data URL («data:application/pdf;base64,…») o null si no lo es. */
export function bytesDeDataUrl(url: string | null | undefined): Buffer | null {
  if (!url || !url.startsWith("data:")) return null;
  const m = url.match(/^data:([^;,]+);base64,([\s\S]+)$/);
  return m ? Buffer.from(m[2], "base64") : null;
}

/** Los bytes del acuse que trae el resultado (campo acusePdf o data URL legado). */
function pdfDeResultado(result: ComplianceResult): { data: Uint8Array<ArrayBuffer>; nombre: string } | null {
  const fecha = new Date(result.fetchedAt);
  // `new Uint8Array(x)` copia a un ArrayBuffer propio: es lo que Prisma pide para Bytes.
  if (result.acusePdf && result.acusePdf.byteLength > 0) {
    return { data: new Uint8Array(result.acusePdf), nombre: result.acusePdfNombre ?? nombreAcuse(result.tipo, fecha) };
  }
  const data = bytesDeDataUrl(result.acuseUrl);
  return data ? { data: new Uint8Array(data), nombre: result.acusePdfNombre ?? nombreAcuse(result.tipo, fecha) } : null;
}

export interface PersistResult {
  tipo: string;
  changed: boolean;
  hallazgos: number;
  /** True cuando el contenido no cambió pero el snapshot vigente recibió el PDF que le faltaba. */
  pdfGuardado?: boolean;
}

/** Guarda el resultado si cambió y materializa los hallazgos derivados. */
export async function persistComplianceResult(
  companyId: string,
  result: ComplianceResult,
): Promise<PersistResult> {
  const tipo = result.tipo;
  const hash = hashContenido(result);
  const pdf = pdfDeResultado(result);
  // La referencia al proveedor sólo se conserva cuando es eso, una referencia;
  // una data URL de ~1 MB en una columna de texto era el acuse mal guardado.
  const acuseUrl = result.acuseUrl && !result.acuseUrl.startsWith("data:") ? result.acuseUrl : null;

  const last = await prisma.complianceSnapshot.findFirst({
    where: { companyId, tipo },
    orderBy: { fetchedAt: "desc" },
    select: { id: true, tipo: true, resultado: true, motivos: true, perfil: true, fetchedAt: true, contenidoHash: true, acusePdfNombre: true },
  });
  if (last && last.contenidoHash === hash) {
    // Mismo contenido: no se abre snapshot nuevo, pero si el vigente no tiene
    // el PDF y esta corrida lo trae, se le adjunta (gap-fill, una sola vez).
    if (pdf && !last.acusePdfNombre) {
      await prisma.complianceSnapshot.update({
        where: { id: last.id },
        data: { acusePdf: pdf.data, acusePdfNombre: pdf.nombre, ...(acuseUrl ? { acuseUrl } : {}) },
      });
      return { tipo, changed: false, hallazgos: 0, pdfGuardado: true };
    }
    return { tipo, changed: false, hallazgos: 0 };
  }

  const prev = last ? reconstruir(last) : null;
  const hallazgos = evaluarCambioCumplimiento(result, prev);

  const esCsf = result.tipo === "CSF";
  await prisma.complianceSnapshot.create({
    data: {
      companyId,
      tipo,
      resultado: esCsf ? result.perfil.estatusPadron : result.resultado,
      motivos: esCsf ? [] : result.motivos,
      perfil: esCsf ? (result.perfil as unknown as Prisma.InputJsonValue) : undefined,
      acuseUrl,
      acusePdf: pdf?.data ?? null,
      acusePdfNombre: pdf?.nombre ?? null,
      contenidoHash: hash,
      vigencia: !esCsf && result.vigencia ? toDate(result.vigencia) : null,
    },
  });

  for (const h of hallazgos) {
    const dedupeKey = `${h.checkClave}|${h.referencias.join(",")}`;
    await prisma.fiscalHallazgo.upsert({
      where: { companyId_dedupeKey: { companyId, dedupeKey } },
      create: {
        companyId,
        dedupeKey,
        checkClave: h.checkClave,
        severidad: h.severidad,
        mensaje: h.mensaje,
        referencias: h.referencias,
        sugerencia: h.sugerencia,
        fundamentoLey: h.fundamento.ley,
        fundamentoArticulo: h.fundamento.articulo,
        fundamentoFraccion: h.fundamento.fraccion ?? null,
      },
      update: { severidad: h.severidad, mensaje: h.mensaje, referencias: h.referencias, sugerencia: h.sugerencia },
      select: { id: true },
    });
  }

  return { tipo, changed: true, hallazgos: hallazgos.length };
}

export type DescargaAcuse = (ref: string) => Promise<{ data: ArrayBuffer | Buffer | Uint8Array; contentType: string; filename?: string }>;

export type EstadoAcusePdf = "ya_tenia" | "guardado" | "sin_fuente" | "sin_snapshot" | "error";

/**
 * Asegura que un snapshot tenga el PDF en la base. Sin `snapshotId` toma el
 * más reciente de (empresa, tipo). Fuentes, en orden: la data URL legado que
 * el proveedor IMSS guardaba en acuseUrl, o la referencia a Syntage bajada con
 * `descargar`. Idempotente: si ya tiene bytes no toca nada ni descarga.
 */
export async function asegurarAcusePdf(
  companyId: string,
  tipo: TipoCumplimiento | string,
  descargar?: DescargaAcuse,
  snapshotId?: string,
): Promise<{ estado: EstadoAcusePdf; snapshotId?: string; error?: string }> {
  const snap = await prisma.complianceSnapshot.findFirst({
    where: snapshotId ? { id: snapshotId } : { companyId, tipo },
    orderBy: { fetchedAt: "desc" },
    select: { id: true, tipo: true, acuseUrl: true, acusePdfNombre: true, fetchedAt: true },
  });
  if (!snap) return { estado: "sin_snapshot" };
  if (snap.acusePdfNombre) return { estado: "ya_tenia", snapshotId: snap.id };
  if (!snap.acuseUrl) return { estado: "sin_fuente", snapshotId: snap.id };

  const nombre = nombreAcuse(snap.tipo, snap.fetchedAt);
  const enBase = bytesDeDataUrl(snap.acuseUrl);
  if (enBase) {
    // La data URL se reemplaza por los bytes: la columna de texto deja de cargar ~1 MB.
    await prisma.complianceSnapshot.update({
      where: { id: snap.id },
      data: { acusePdf: new Uint8Array(enBase), acusePdfNombre: nombre, acuseUrl: null },
    });
    return { estado: "guardado", snapshotId: snap.id };
  }
  if (!descargar) return { estado: "sin_fuente", snapshotId: snap.id };
  try {
    const bajado = await descargar(snap.acuseUrl);
    const data = new Uint8Array(bajado.data as ArrayBuffer);
    if (data.byteLength === 0 || !/pdf|octet/.test(bajado.contentType)) {
      return { estado: "error", snapshotId: snap.id, error: `respuesta ${bajado.contentType || "vacía"} (${data.byteLength} b)` };
    }
    await prisma.complianceSnapshot.update({
      where: { id: snap.id },
      data: { acusePdf: data, acusePdfNombre: bajado.filename?.endsWith(".pdf") ? bajado.filename : nombre },
    });
    return { estado: "guardado", snapshotId: snap.id };
  } catch (e) {
    return { estado: "error", snapshotId: snap.id, error: e instanceof Error ? e.message : String(e) };
  }
}

function toDate(s: string): Date | null {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
