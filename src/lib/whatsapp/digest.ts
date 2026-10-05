// ─────────────────────────────────────────────────────────────────────────────
// Resumen diario de la cartera por WhatsApp ("buenos días, esto tienes hoy").
//
// Llega a todo número VERIFICADO salvo que la persona lo apague en Ajustes
// (`WhatsappLink.digestOptOut`; antes era opt-in y corría con 0 candidatos).
// Para cada uno arma el estado de todas las empresas que puede ver —SAT
// detenido, hallazgos, avisos del cierre— y la próxima fecha de declaración.
//
// Entrega: el digest es un mensaje INICIADO POR EL NEGOCIO. Fuera de la ventana
// de servicio de 24h, WhatsApp/Meta exige una PLANTILLA aprobada (error 63016).
// Por eso es "template-aware": si `TWILIO_DIGEST_TEMPLATE_SID` está configurado
// usa la plantilla (el cuerpo va en la variable "1"); si no, cae al envío
// freeform, que sólo se entrega si el usuario escribió en las últimas 24h.
//
// El formateo es PURO (sin DB) para poder probarlo; la orquestación sólo lo
// alimenta. No usa LLM, así que su costo es ~0.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { listAccessibleCompanies } from "./identity";
import { sendWhatsappMessage, sendWhatsappTemplate } from "./twilio";
import { lineasCierreParaDigest } from "../cierre/pase-diario";
import { saludSincronizacion, type MotivoDetenida } from "../sat-salud";

/** Resumen por empresa para el formateador (puro). */
export interface EmpresaResumen {
  razonSocial: string;
  hallazgos: number;
  criticos: number;
  /** La descarga del SAT está detenida (e.firma vencida/revocada o sin avanzar). */
  syncDetenida?: MotivoDetenida | null;
}

const MOTIVO_TXT: Record<MotivoDetenida, string> = {
  fiel_vencida: "e.firma vencida, sin descarga del SAT",
  fiel_revocada: "e.firma revocada por el SAT, sin descarga",
  sin_sync: "sin descarga del SAT hace más de una semana",
};

/** Próxima fecha de las mensuales (día 17; sábado/domingo → lunes). */
export function proximaDeclaracionMensual(hoy: Date): { periodo: string; vence: Date; dias: number } {
  const mx = new Date(hoy.toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
  const y = mx.getFullYear(), m = mx.getMonth(); // m: 0-11
  const [vy, vm] = mx.getDate() <= 17 ? [y, m] : m === 11 ? [y + 1, 0] : [y, m + 1];
  const vence = new Date(vy, vm, 17);
  const dow = vence.getDay();
  if (dow === 6) vence.setDate(19);
  if (dow === 0) vence.setDate(18);
  const per = new Date(vy, vm - 1, 1);
  const periodo = per.toLocaleDateString("es-MX", { month: "long" });
  const hoy0 = new Date(mx.getFullYear(), mx.getMonth(), mx.getDate());
  return { periodo, vence, dias: Math.round((vence.getTime() - hoy0.getTime()) / 86_400_000) };
}

/** Cuántas empresas con pendientes listar por nombre antes de resumir el resto. */
const MAX_LISTADAS = 8;

/**
 * Arma el texto del resumen de cartera (PURO). Devuelve null si el usuario no
 * tiene empresas (nada que reportar). Si hay empresas pero ninguna con
 * pendientes, devuelve un mensaje de "todo al corriente" (es un resumen DIARIO
 * que el usuario pidió; el verde también es señal).
 */
/** Aviso del cierre guiado de hoy (una línea por aviso, ya redactada). */
export interface LineaCierre {
  empresa: string;
  linea: string;
}

export function formatCarteraDigest(
  empresas: ReadonlyArray<EmpresaResumen>,
  cierre: ReadonlyArray<LineaCierre> = []
): string | null {
  if (empresas.length === 0) return null;
  const bloqueCierre =
    cierre.length > 0
      ? ["", "Cierre guiado hoy:", ...cierre.map((c) => `- ${c.linea}`)]
      : [];

  const conPendientes = empresas
    .filter((e) => e.hallazgos > 0 || e.syncDetenida)
    .sort((a, b) => b.criticos - a.criticos || b.hallazgos - a.hallazgos);
  const alCorriente = empresas.length - conPendientes.length;
  const n = empresas.length;

  const cabecera = `Buenos días. Resumen de tu cartera (${n} empresa${n === 1 ? "" : "s"}).`;

  if (conPendientes.length === 0) {
    return [
      `${cabecera}\nTodas al corriente. Sin hallazgos abiertos.`,
      ...bloqueCierre,
      "\nEscríbeme el nombre de una empresa si quieres revisar algo.",
    ].join("\n");
  }

  const listadas = conPendientes.slice(0, MAX_LISTADAS);
  const lineas = listadas.map((e) => {
    const crit = e.criticos > 0 ? ` (${e.criticos} crítico${e.criticos === 1 ? "" : "s"})` : "";
    const sat = e.syncDetenida ? `${MOTIVO_TXT[e.syncDetenida]}; ` : "";
    return `- ${e.razonSocial}: ${sat}${e.hallazgos} hallazgo${e.hallazgos === 1 ? "" : "s"}${crit}`;
  });

  const restantes = conPendientes.length - listadas.length;
  const partes = [
    cabecera,
    `Con pendientes (${conPendientes.length}):`,
    ...lineas,
  ];
  if (restantes > 0) partes.push(`y ${restantes} empresa${restantes === 1 ? "" : "s"} más con pendientes.`);
  if (alCorriente > 0) partes.push(`${alCorriente} al corriente.`);
  partes.push(...bloqueCierre);
  partes.push("\nEscríbeme el nombre de una empresa para ver el detalle.");

  return partes.join("\n");
}

/** Tope de {{1}}: WhatsApp limita el cuerpo de la plantilla (~1,024 con el texto fijo). */
const MAX_LINEA = 850;
const MAX_EMPRESAS_LINEA = 5;

/**
 * El resumen en UNA línea para {{1}} de la plantilla («Buenos días. Resumen de
 * tu cartera de Contabilidad OS: {{1}}. Responde con el nombre…»). Sin saltos,
 * tabs ni punto final (lo pone la plantilla). Lleva lo que importa por
 * empresa —SAT detenido, críticos, avisos del cierre— y la próxima fecha de
 * declaración. Devuelve null si no hay empresas.
 */
export function formatCarteraDigestSummaryLine(
  empresas: ReadonlyArray<EmpresaResumen>,
  cierre: ReadonlyArray<LineaCierre> = [],
  hoy: Date = new Date(),
): string | null {
  if (empresas.length === 0) return null;
  const avisos = new Map<string, string[]>();
  for (const c of cierre) avisos.set(c.empresa, [...(avisos.get(c.empresa) ?? []), c.linea]);

  const conAlgo = empresas
    .filter((e) => e.syncDetenida || e.hallazgos > 0 || avisos.has(e.razonSocial))
    .sort((a, b) => Number(!!b.syncDetenida) - Number(!!a.syncDetenida) || b.criticos - a.criticos || b.hallazgos - a.hallazgos);

  const partes = conAlgo.slice(0, MAX_EMPRESAS_LINEA).map((e) => {
    const cosas: string[] = [];
    if (e.syncDetenida) cosas.push(MOTIVO_TXT[e.syncDetenida]);
    if (e.criticos > 0) cosas.push(`${e.criticos} crítico${e.criticos === 1 ? "" : "s"}`);
    const resto = e.hallazgos - e.criticos;
    if (resto > 0) cosas.push(`${resto} pendiente${resto === 1 ? "" : "s"}`);
    for (const a of avisos.get(e.razonSocial) ?? []) cosas.push(a.replace(/[.\s]+$/, ""));
    return `${e.razonSocial}: ${cosas.join(", ")}`;
  });
  const masEmpresas = conAlgo.length - partes.length;
  if (masEmpresas > 0) partes.push(`y ${masEmpresas} empresa${masEmpresas === 1 ? "" : "s"} más con pendientes`);
  const alCorriente = empresas.length - conAlgo.length;
  if (alCorriente > 0) partes.push(`${alCorriente} al corriente`);

  const d = proximaDeclaracionMensual(hoy);
  const fecha = d.vence.toLocaleDateString("es-MX", { day: "numeric", month: "long" });
  partes.push(`declaraciones de ${d.periodo} vencen el ${fecha}${d.dias >= 0 ? ` (${d.dias === 0 ? "hoy" : d.dias === 1 ? "mañana" : `en ${d.dias} días`})` : ""}`);

  let linea = partes.join(" · ").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  if (linea.length > MAX_LINEA) linea = linea.slice(0, MAX_LINEA - 1).replace(/\s+\S*$/, "") + "…";
  return linea.replace(/[.\s]+$/, "");
}

/**
 * Calcula el resumen por empresa accesible del usuario (hallazgos ABIERTOS, sin
 * pospuestos vigentes). Mantiene el orden por razón social que da identity.
 */
export async function computeCarteraResumen(userId: string): Promise<EmpresaResumen[]> {
  const companies = await listAccessibleCompanies(userId);
  if (companies.length === 0) return [];

  const grupos = await prisma.fiscalHallazgo.groupBy({
    by: ["companyId", "severidad"],
    where: {
      companyId: { in: companies.map((c) => c.id) },
      estado: "ABIERTO",
      OR: [{ posponerHasta: null }, { posponerHasta: { lte: new Date() } }],
    },
    _count: true,
  });

  const porEmpresa = new Map<string, { hallazgos: number; criticos: number }>();
  for (const g of grupos) {
    const cur = porEmpresa.get(g.companyId) ?? { hallazgos: 0, criticos: 0 };
    cur.hallazgos += g._count;
    if (g.severidad === "error") cur.criticos += g._count;
    porEmpresa.set(g.companyId, cur);
  }

  const salud = await Promise.all(companies.map((c) => saludSincronizacion(c.id).catch(() => null)));
  return companies.map((c, i) => ({
    razonSocial: c.razonSocial,
    hallazgos: porEmpresa.get(c.id)?.hallazgos ?? 0,
    criticos: porEmpresa.get(c.id)?.criticos ?? 0,
    syncDetenida: salud[i]?.detenida ? salud[i]!.motivo : null,
  }));
}

/**
 * Envía el resumen a un número. Si hay plantilla configurada
 * (`TWILIO_DIGEST_TEMPLATE_SID`) la usa con el resumen de UNA línea en la
 * variable {{1}} (las plantillas no admiten saltos de línea en variables); si
 * no, cae al freeform con el cuerpo multilínea completo (sólo entregable dentro
 * de la ventana de 24h). Devuelve true si se envió, false si se omitió/falló.
 */
export async function sendCarteraDigest(
  phoneE164: string,
  textoCompleto: string,
  resumenLinea: string
): Promise<boolean> {
  const templateSid = process.env.TWILIO_DIGEST_TEMPLATE_SID;
  try {
    if (templateSid) {
      await sendWhatsappTemplate(phoneE164, templateSid, { "1": resumenLinea });
    } else {
      await sendWhatsappMessage(phoneE164, textoCompleto);
    }
    return true;
  } catch (e) {
    // Fuera de la ventana de 24h sin plantilla, Meta rechaza con 63016: no es un
    // error operativo, sólo no se pudo entregar. Lo registramos y seguimos.
    console.warn("[whatsapp] digest no entregado", {
      phone: phoneE164,
      motivo: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

export interface DigestRunResult {
  candidatos: number;
  enviados: number;
  omitidos: number;
}

/**
 * Corre el digest de cartera para TODOS los links verificados con la preferencia
 * activa. Un envío por link. No usa LLM. Best-effort: el fallo de uno no detiene
 * a los demás.
 */
export async function runWhatsappCarteraDigest(): Promise<DigestRunResult> {
  const links = await prisma.whatsappLink.findMany({
    where: { verifiedAt: { not: null }, digestOptOut: false },
    select: { phoneE164: true, userId: true },
  });

  let enviados = 0;
  let omitidos = 0;
  for (const link of links) {
    try {
      const resumen = await computeCarteraResumen(link.userId);
      const cierre = await lineasCierreParaDigest(
        (await listAccessibleCompanies(link.userId)).map((c) => c.id)
      ).catch(() => []);
      const texto = formatCarteraDigest(resumen, cierre);
      const linea = formatCarteraDigestSummaryLine(resumen, cierre);
      if (!texto || !linea) {
        omitidos++;
        continue;
      }
      const ok = await sendCarteraDigest(link.phoneE164, texto, linea);
      ok ? enviados++ : omitidos++;
    } catch (e) {
      omitidos++;
      console.warn("[whatsapp] digest error para link", {
        userId: link.userId,
        motivo: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { candidatos: links.length, enviados, omitidos };
}
