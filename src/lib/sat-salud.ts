// ─────────────────────────────────────────────────────────────────────────────
// ¿La sincronización con el SAT de esta empresa está DETENIDA?
//
// Tres formas de morir en silencio, vistas en producción el 2-oct-2026:
//   · fiel_vencida  — el certificado venció (BAHJ desde el 25-jul, TMA desde el
//                     13-sep): getFielForCompany lanza y el cron acumula el error.
//   · fiel_revocada — el .cer sigue vigente en fecha pero el SAT lo rechaza con
//                     304 «Certificado Revocado o Caduco» (TEGJ: tramitó una
//                     e.firma nueva y la vieja quedó revocada). Nada local lo
//                     detecta: sólo el rechazo del SAT.
//   · sin_sync      — ninguna de las dos, pero lastAutoSyncAt lleva más de una
//                     semana sin avanzar.
// La decisión es PURA (diagnosticarSync); la consulta vive en saludSincronizacion.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "./prisma";
import { fielStatus, type FielStatus } from "./fiel";

export type MotivoDetenida = "fiel_vencida" | "fiel_revocada" | "sin_sync";

export interface EntradaSalud {
  fiel: FielStatus;
  autoSyncEnabled: boolean;
  createdAt: Date;
  lastAutoSyncAt: Date | null;
  /** Fechas de rechazos del SAT por certificado (304) en los últimos días. */
  rechazosCertificado: Date[];
  /** Última solicitud de XML terminada con éxito. */
  ultimoFinished: Date | null;
}

export interface SaludSync {
  detenida: boolean;
  motivo: MotivoDetenida | null;
  /** Desde cuándo (ISO), si se sabe. */
  desde: string | null;
  /** Texto para la persona: qué pasa y qué hacer. */
  detalle: string;
}

export const DIAS_SIN_SYNC = 7;
const RE_CERTIFICADO_SAT = /Certificado Revocado o Caduco|c[oó]digo 304/i;

const fmt = (d: Date) => d.toLocaleDateString("es-MX", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "America/Mexico_City" });

export function esRechazoCertificado(errorMessage: string | null | undefined): boolean {
  return RE_CERTIFICADO_SAT.test(errorMessage ?? "");
}

export function diagnosticarSync(e: EntradaSalud, hoy: Date, diasSinSync = DIAS_SIN_SYNC): SaludSync {
  if (e.fiel.estado === "vencida") {
    const desde = e.fiel.vigencia ? new Date(e.fiel.vigencia) : null;
    return {
      detenida: true,
      motivo: "fiel_vencida",
      desde: desde?.toISOString() ?? null,
      detalle: `La sincronización con el SAT está detenida: la e.firma venció${desde ? ` el ${fmt(desde)}` : ""}. Renueva la e.firma en el SAT y sube los archivos .cer y .key vigentes en Mi Empresa.`,
    };
  }
  if (e.rechazosCertificado.length > 0) {
    const primero = new Date(Math.min(...e.rechazosCertificado.map((d) => d.getTime())));
    // Si hubo una descarga exitosa DESPUÉS del primer rechazo, el certificado ya se repuso.
    if (!e.ultimoFinished || e.ultimoFinished.getTime() < primero.getTime()) {
      return {
        detenida: true,
        motivo: "fiel_revocada",
        desde: primero.toISOString(),
        detalle: `La sincronización con el SAT está detenida desde el ${fmt(primero)}: el SAT rechaza la e.firma como revocada o caduca (código 304). Suele pasar cuando se tramitó una e.firma nueva: sube los archivos .cer y .key vigentes en Mi Empresa.`,
      };
    }
  }
  const corte = hoy.getTime() - diasSinSync * 86_400_000;
  if (e.autoSyncEnabled && e.fiel.estado !== "sin_fiel" && e.createdAt.getTime() < corte && (!e.lastAutoSyncAt || e.lastAutoSyncAt.getTime() < corte)) {
    return {
      detenida: true,
      motivo: "sin_sync",
      desde: e.lastAutoSyncAt?.toISOString() ?? null,
      detalle: `La sincronización con el SAT no avanza desde ${e.lastAutoSyncAt ? `el ${fmt(e.lastAutoSyncAt)}` : "que se dio de alta la empresa"}. Revisa la e.firma en Mi Empresa o escríbenos.`,
    };
  }
  return { detenida: false, motivo: null, desde: null, detalle: "" };
}

const DIAS_VENTANA_RECHAZOS = 14;

export async function saludSincronizacion(companyId: string, hoy = new Date()): Promise<SaludSync | null> {
  const c = await prisma.company.findUnique({
    where: { id: companyId },
    select: { fielCer: true, fielVigencia: true, autoSyncEnabled: true, createdAt: true, lastAutoSyncAt: true, isActive: true },
  });
  if (!c || !c.isActive) return null;
  const desde = new Date(hoy.getTime() - DIAS_VENTANA_RECHAZOS * 86_400_000);
  const [fallos, finished] = await Promise.all([
    prisma.satSyncRequest.findMany({
      where: { companyId, status: "FAILED", createdAt: { gte: desde }, tipo: { in: ["EMITIDOS", "RECIBIDOS"] } },
      select: { createdAt: true, errorMessage: true },
    }),
    prisma.satSyncRequest.findFirst({
      where: { companyId, status: "FINISHED", tipo: { in: ["EMITIDOS", "RECIBIDOS"] } },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true },
    }),
  ]);
  return diagnosticarSync(
    {
      fiel: fielStatus({ fielCer: c.fielCer, fielVigencia: c.fielVigencia }),
      autoSyncEnabled: c.autoSyncEnabled,
      createdAt: c.createdAt,
      lastAutoSyncAt: c.lastAutoSyncAt,
      rechazosCertificado: fallos.filter((f) => esRechazoCertificado(f.errorMessage)).map((f) => f.createdAt),
      ultimoFinished: finished?.updatedAt ?? null,
    },
    hoy,
  );
}

export interface EmpresaDetenida extends SaludSync {
  companyId: string;
  rfc: string;
  razonSocial: string;
  /** Usuarios con acceso a los que ya se les creó el aviso de e.firma. */
  avisados: number;
}

/** Para el operador: todas las empresas activas con e.firma cuya sincronización está detenida. */
export async function empresasConSyncDetenida(hoy = new Date()): Promise<EmpresaDetenida[]> {
  const cs = await prisma.company.findMany({
    where: { isActive: true, fielCer: { not: null } },
    select: { id: true, rfc: true, razonSocial: true },
    orderBy: { razonSocial: "asc" },
  });
  const out: EmpresaDetenida[] = [];
  for (const c of cs) {
    const s = await saludSincronizacion(c.id, hoy);
    if (!s?.detenida) continue;
    const avisados = await prisma.notificationItem.count({ where: { companyId: c.id, dedupeKey: { startsWith: "fiel-invalida:" } } });
    out.push({ companyId: c.id, rfc: c.rfc, razonSocial: c.razonSocial, avisados, ...s });
  }
  return out;
}
