// ─────────────────────────────────────────────────────────────────────────────
// Firmas electrónicas simples sobre un HospDocumento (Código de Comercio 89,
// LFPDPPP, NOM-004 10.1.1 para consentimientos).
//
// Cadena de evidencia: el documento tiene `hashContenido` (sha256 del texto
// firmado + contenido); cada HospFirma repite ese hash como `hashDocumento` y
// añade `hashFirma` = sha256(imagen|hashDocumento|rol|nombre|at) con IP, user
// agent, geolocalización y usuario que capturó. Nada se edita ni se borra: un
// rol (o su alternativa, PACIENTE|REPRESENTANTE) firma una sola vez (409). El
// documento pasa a FIRMADO sólo cuando todos los grupos requeridos firmaron.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";
import type { HospDocumento, HospFirma, HospFirmanteRol, Prisma, PrismaClient } from "@prisma/client";
import { TIPOS_CONSENTIMIENTO, errorContenido } from "./documentos";
import { HospitalError } from "./errores";
import { ROLES_FIRMANTE, firmasRequeridasPara, parsearFirmasRequeridas } from "./plantillas-legales";

type Db = PrismaClient | Prisma.TransactionClient;

export const MAX_IMAGEN_FIRMA_BYTES = 300 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** El trazo: data URL PNG ≤ 300 KB con la firma del formato. */
export function validarImagenFirma(imagen: unknown): { ok: true; bytes: number } | { ok: false; error: string } {
  if (typeof imagen !== "string" || !imagen) return { ok: false, error: "imagen requerida: data URL PNG del trazo (data:image/png;base64,…)" };
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(imagen);
  if (!m) return { ok: false, error: "imagen debe ser un data URL PNG (data:image/png;base64,…)" };
  const b64 = m[1].replace(/\s/g, "");
  if (b64.length > Math.ceil((MAX_IMAGEN_FIRMA_BYTES * 4) / 3) + 4) return { ok: false, error: `La imagen de la firma excede ${MAX_IMAGEN_FIRMA_BYTES / 1024} KB` };
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0 || buf.length > MAX_IMAGEN_FIRMA_BYTES) return { ok: false, error: `La imagen de la firma excede ${MAX_IMAGEN_FIRMA_BYTES / 1024} KB` };
  if (buf.length < PNG_MAGIC.length || !buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return { ok: false, error: "La imagen de la firma no es un PNG válido" };
  return { ok: true, bytes: buf.length };
}

export function hashFirma(a: { imagen: string; hashDocumento: string; rol: string; nombre: string; at: Date }): string {
  return createHash("sha256").update(`${a.imagen}|${a.hashDocumento}|${a.rol}|${a.nombre}|${a.at.toISOString()}`, "utf8").digest("hex");
}

/** El grupo («PACIENTE|REPRESENTANTE») al que pertenece un rol dentro de los requeridos; null si no se pide. */
export function grupoDeRol(requeridas: readonly string[], rol: string): string | null {
  return requeridas.find((g) => g.split("|").includes(rol)) ?? null;
}

/** Grupos requeridos que todavía no tienen firma. */
export function firmasFaltantes(requeridas: readonly string[], firmas: ReadonlyArray<{ rol: string }>): string[] {
  const roles = new Set(firmas.map((f) => f.rol));
  return requeridas.filter((g) => !g.split("|").some((r) => roles.has(r)));
}

export function verificarHashFirma(f: Pick<HospFirma, "imagen" | "hashDocumento" | "rol" | "nombre" | "at" | "hashFirma">, hashContenido: string | null): boolean | null {
  if (!f.imagen) return null;
  return hashFirma({ imagen: f.imagen, hashDocumento: f.hashDocumento, rol: f.rol, nombre: f.nombre, at: f.at }) === f.hashFirma && f.hashDocumento === hashContenido;
}

// ── Serialización ────────────────────────────────────────────────────────────

export function firmaResumen(f: HospFirma, opts: { conImagen?: boolean; hashContenido?: string | null } = {}) {
  return {
    id: f.id,
    documentoId: f.documentoId,
    rol: f.rol,
    nombre: f.nombre,
    identificacion: f.identificacion,
    parentesco: f.parentesco,
    metodo: f.metodo,
    at: f.at,
    ip: f.ip,
    userAgent: f.userAgent,
    geolocalizacion: f.geolocalizacion,
    userId: f.userId,
    userEmail: f.userEmail,
    hashDocumento: f.hashDocumento,
    hashFirma: f.hashFirma,
    otpVerificado: f.otpVerificado,
    tieneImagen: !!f.imagen,
    ...(opts.conImagen ? { imagen: f.imagen } : {}),
    ...(opts.hashContenido !== undefined ? { hashVerificado: verificarHashFirma(f, opts.hashContenido) } : {}),
  };
}

export type DocumentoConFirmasFila = Omit<HospDocumento, "archivo"> & { archivo?: Uint8Array | null; firmas: HospFirma[] };

/** Documento sin bytes + firmas (sin imagen salvo que se pida) + evidencia. */
export function documentoConFirmas(doc: DocumentoConFirmasFila, opts: { conImagen?: boolean; conTexto?: boolean } = {}) {
  const { archivo, firmas, textoFirmado, ...resto } = doc;
  const requeridas = doc.firmasRequeridas == null ? firmasRequeridasPara(doc.tipo) : parsearFirmasRequeridas(doc.firmasRequeridas);
  const faltan = firmasFaltantes(requeridas, firmas);
  return {
    ...resto,
    ...(opts.conTexto === false ? {} : { textoFirmado }),
    tieneTexto: !!textoFirmado,
    tieneArchivo: !!archivo || (doc.bytes ?? 0) > 0,
    firmasRequeridas: requeridas,
    firmasFaltantes: faltan,
    firmas: [...firmas].sort((a, b) => a.at.getTime() - b.at.getTime()).map((f) => firmaResumen(f, { conImagen: opts.conImagen, hashContenido: doc.hashContenido })),
    evidencia: {
      hashContenido: doc.hashContenido,
      plantillaVersion: doc.plantillaVersion,
      completo: requeridas.length > 0 && faltan.length === 0,
      firmas: firmas.map((f) => ({ rol: f.rol, nombre: f.nombre, at: f.at, ip: f.ip, hashFirma: f.hashFirma })),
    },
  };
}

export type DocumentoSerializado = ReturnType<typeof documentoConFirmas>;

// ── Firmar ───────────────────────────────────────────────────────────────────

export interface FirmarDocumentoArgs {
  documentoId: string;
  rol: HospFirmanteRol;
  nombre: string;
  identificacion?: string | null;
  parentesco?: string | null;
  /** data URL PNG. */
  imagen: string;
  geolocalizacion?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  user?: { id?: string | null; email?: string | null } | null;
  ahora?: Date;
}

const ROLES_TITULAR: readonly HospFirmanteRol[] = ["PACIENTE", "REPRESENTANTE", "RESPONSABLE_PAGO"];

/**
 * Registra una firma y, si con ella se completan las requeridas, marca el
 * documento FIRMADO (y el aviso de privacidad aceptado en la ficha). Corre en
 * una transacción con candado por documento: dos firmas simultáneas del mismo
 * rol no se cuelan.
 */
export async function firmarDocumento(db: PrismaClient, a: FirmarDocumentoArgs): Promise<{ documento: DocumentoSerializado; firma: ReturnType<typeof firmaResumen>; faltan: string[] }> {
  const nombre = a.nombre.trim();
  if (!nombre) throw new HospitalError(400, "El nombre de quien firma es obligatorio");
  if (!ROLES_FIRMANTE.includes(a.rol)) throw new HospitalError(400, `Rol de firmante inválido: ${a.rol}`);
  const imagen = validarImagenFirma(a.imagen);
  if (!imagen.ok) throw new HospitalError(400, imagen.error);
  const parentesco = a.parentesco?.trim() || null;
  if (a.rol === "REPRESENTANTE" && !parentesco) throw new HospitalError(400, "El representante debe indicar su parentesco o carácter (padre, tutor, cónyuge…)");
  const at = a.ahora ?? new Date();

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hosp-firma:${a.documentoId}`}))`;
    const doc = await tx.hospDocumento.findUnique({ where: { id: a.documentoId }, omit: { archivo: true }, include: { firmas: true } });
    if (!doc) throw new HospitalError(404, "Documento no encontrado");
    if (!doc.hashContenido || !doc.textoFirmado) {
      throw new HospitalError(409, `El documento «${doc.nombre}» no tiene texto firmable: genera el paquete de admisión o regístralo con su plantilla antes de firmar`);
    }
    if (doc.estado === "FIRMADO") throw new HospitalError(409, `El documento «${doc.nombre}» ya está firmado; las firmas no se modifican`);

    const requeridas = doc.firmasRequeridas == null ? firmasRequeridasPara(doc.tipo) : parsearFirmasRequeridas(doc.firmasRequeridas);
    if (!requeridas.length) throw new HospitalError(409, `El documento «${doc.nombre}» (${doc.tipo}) no se firma electrónicamente: se recibe como archivo`);
    const grupo = grupoDeRol(requeridas, a.rol);
    if (!grupo) throw new HospitalError(400, `El documento «${doc.nombre}» no requiere la firma de ${a.rol}; requiere: ${requeridas.join(", ")}`);
    const yaFirmo = doc.firmas.find((f) => grupo.split("|").includes(f.rol));
    if (yaFirmo) {
      throw new HospitalError(409, `${grupo} ya firmó «${doc.nombre}» (${yaFirmo.rol}: ${yaFirmo.nombre}, ${yaFirmo.at.toISOString()}); las firmas no se modifican ni se repiten`);
    }
    // Un consentimiento NOM-004 no se firma sin su contenido mínimo.
    if (TIPOS_CONSENTIMIENTO.includes(doc.tipo)) {
      const motivo = errorContenido(doc.tipo, doc.contenido, true);
      if (motivo) throw new HospitalError(400, motivo);
    }

    const firma = await tx.hospFirma.create({
      data: {
        companyId: doc.companyId,
        documentoId: doc.id,
        rol: a.rol,
        nombre,
        identificacion: a.identificacion?.trim().toUpperCase() || null,
        parentesco,
        metodo: "AUTOGRAFA_DIGITAL",
        imagen: a.imagen,
        hashDocumento: doc.hashContenido,
        hashFirma: hashFirma({ imagen: a.imagen, hashDocumento: doc.hashContenido, rol: a.rol, nombre, at }),
        ip: a.ip ?? null,
        userAgent: a.userAgent?.slice(0, 300) ?? null,
        geolocalizacion: a.geolocalizacion?.trim().slice(0, 120) || null,
        userId: a.user?.id ?? null,
        userEmail: a.user?.email ?? null,
        at,
      },
    });

    const firmas = [...doc.firmas, firma];
    const faltan = firmasFaltantes(requeridas, firmas);
    const completo = faltan.length === 0;

    // Espejo en las columnas P1 (firmadoPor, testigos, médico) para que el
    // expediente y la lista de pendientes sigan leyendo lo mismo.
    const espejo: Prisma.HospDocumentoUpdateInput = {};
    if (ROLES_TITULAR.includes(a.rol) && !doc.firmadoPor) {
      espejo.firmadoPor = nombre;
      espejo.firmadoParentesco = a.rol === "PACIENTE" ? "Paciente" : a.rol === "RESPONSABLE_PAGO" ? (parentesco ?? "Responsable de pago") : parentesco;
    }
    if (a.rol === "TESTIGO1" && !doc.testigo1) espejo.testigo1 = nombre;
    if (a.rol === "TESTIGO2" && !doc.testigo2) espejo.testigo2 = nombre;
    if (a.rol === "MEDICO" && !doc.medicoNombre) espejo.medicoNombre = nombre;

    const actualizado = await tx.hospDocumento.update({
      where: { id: doc.id },
      data: { ...espejo, ...(completo ? { estado: "FIRMADO", firmadoAt: at } : {}) },
      omit: { archivo: true },
      include: { firmas: true },
    });

    if (completo && doc.tipo === "AVISO_PRIVACIDAD") {
      await tx.hospPaciente.update({
        where: { id: doc.pacienteId },
        data: { avisoPrivacidadAceptadoAt: at, ...(doc.plantillaVersion ? { avisoPrivacidadVersion: doc.plantillaVersion } : {}) },
      });
    }

    return { documento: documentoConFirmas(actualizado), firma: firmaResumen(firma, { hashContenido: doc.hashContenido }), faltan };
  });
}

/** Documento + firmas para GET /documentos/[docId]; 404 si no existe. */
export async function cargarDocumento(db: Db, documentoId: string) {
  const doc = await db.hospDocumento.findUnique({
    where: { id: documentoId },
    omit: { archivo: true },
    include: { firmas: { orderBy: { at: "asc" } }, episodio: { select: { id: true, folio: true, tipo: true, estado: true } }, paciente: { select: { id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true, expedienteNumero: true } } },
  });
  if (!doc) throw new HospitalError(404, "Documento no encontrado");
  return doc;
}
