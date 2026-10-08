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
// Por eso elige formato (ver `sendCarteraDigest`): si la persona escribió en
// las últimas 24h va el freeform completo con secciones; si no, la plantilla
// v2 multilínea (`TWILIO_DIGEST_TEMPLATE_V2_SID`) o la v1 de una línea
// (`TWILIO_DIGEST_TEMPLATE_SID`, agrupada por tipo de pendiente).
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

/** Aviso del cierre guiado de hoy (una línea por aviso, ya redactada). */
export interface LineaCierre {
  empresa: string;
  linea: string;
}

const SUFIJOS_SOCIETARIOS =
  /[,\s]+(S\.?\s?A\.?\s?P\.?\s?I\.?|S\.?\s?A\.?\s?B\.?|S\.?\s?A\.?|S\.?\s?C\.?|S\.?\s?A\.?\s?S\.?|A\.?\s?C\.?|S\.?\s?DE\s?R\.?\s?L\.?|S\.?\s?EN\s?C\.?)(\s+DE\s+C\.?\s?V\.?)?\.?\s*$/i;

/**
 * Nombre corto para el digest: sin la forma societaria («S.A. DE C.V.»,
 * «S. DE R.L. DE C.V.», «S.C.»…) y recortado a `max` caracteres.
 */
export function nombreCorto(razonSocial: string, max = 28): string {
  let n = razonSocial.trim().replace(/\s+/g, " ");
  for (let i = 0; i < 2; i++) n = n.replace(SUFIJOS_SOCIETARIOS, "").trim();
  n = n.replace(/[,.\s]+$/, "") || razonSocial.trim();
  return n.length > max ? n.slice(0, max - 1).trimEnd() + "…" : n;
}

const MOTIVO_CORTO: Record<MotivoDetenida, string> = {
  fiel_vencida: "e.firma vencida",
  fiel_revocada: "e.firma revocada",
  sin_sync: "sin descarga hace +7 días",
};

const plural = (n: number, s: string, p = `${s}s`) => `${n} ${n === 1 ? s : p}`;

/** La cartera agrupada por tipo de pendiente (lo comparten los tres formatos). */
interface Grupos {
  total: number;
  sat: Array<{ nombre: string; motivo: MotivoDetenida }>;
  criticas: Array<{ nombre: string; criticos: number; resto: number }>;
  pendientes: Array<{ nombre: string; hallazgos: number }>;
  cierre: Array<{ nombre: string; linea: string }>;
  alCorriente: number;
}

function agrupar(empresas: ReadonlyArray<EmpresaResumen>, cierre: ReadonlyArray<LineaCierre>): Grupos {
  const conAvisos = new Set(cierre.map((c) => c.empresa));
  const sat = empresas
    .filter((e) => e.syncDetenida)
    .map((e) => ({ nombre: nombreCorto(e.razonSocial), motivo: e.syncDetenida! }));
  const criticas = empresas
    .filter((e) => e.criticos > 0)
    .sort((a, b) => b.criticos - a.criticos || b.hallazgos - a.hallazgos)
    .map((e) => ({ nombre: nombreCorto(e.razonSocial), criticos: e.criticos, resto: e.hallazgos - e.criticos }));
  const pendientes = empresas
    .filter((e) => e.criticos === 0 && e.hallazgos > 0)
    .sort((a, b) => b.hallazgos - a.hallazgos)
    .map((e) => ({ nombre: nombreCorto(e.razonSocial), hallazgos: e.hallazgos }));
  const alCorriente = empresas.filter((e) => !e.syncDetenida && e.hallazgos === 0 && !conAvisos.has(e.razonSocial)).length;
  return {
    total: empresas.length,
    sat,
    criticas,
    pendientes,
    cierre: cierre.map((c) => ({ nombre: nombreCorto(c.empresa), linea: c.linea.replace(/[.\s]+$/, "") })),
    alCorriente,
  };
}

function textoDeclaracion(hoy: Date): string {
  const d = proximaDeclaracionMensual(hoy);
  const fecha = d.vence.toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" }).replace(",", "");
  const cuando = d.dias < 0 ? "" : d.dias === 0 ? " (hoy)" : d.dias === 1 ? " (mañana)" : ` (en ${d.dias} días)`;
  return `${d.periodo} vencen el ${fecha}${cuando}`;
}

/** Junta nombres hasta `max` y resume el resto como «+N». */
function lista(items: string[], max: number): string {
  const vis = items.slice(0, max);
  return vis.join(", ") + (items.length > max ? ` +${items.length - max}` : "");
}

/** Cuántas empresas listar por sección en el mensaje completo. */
const MAX_POR_SECCION = 6;

/**
 * El resumen COMPLETO (PURO), multilínea con formato de WhatsApp (*negritas*,
 * secciones con emoji). Se manda freeform cuando la persona está dentro de la
 * ventana de 24h. Devuelve null si no hay empresas.
 */
export function formatCarteraDigest(
  empresas: ReadonlyArray<EmpresaResumen>,
  cierre: ReadonlyArray<LineaCierre> = [],
  hoy: Date = new Date(),
): string | null {
  if (empresas.length === 0) return null;
  const g = agrupar(empresas, cierre);
  const out: string[] = [`☀️ *Buenos días* — tu cartera hoy (${plural(g.total, "empresa")})`];

  const seccion = (titulo: string, filas: string[]) => {
    if (filas.length === 0) return;
    out.push("", titulo, ...filas.slice(0, MAX_POR_SECCION).map((f) => `• ${f}`));
    if (filas.length > MAX_POR_SECCION) out.push(`• y ${plural(filas.length - MAX_POR_SECCION, "más", "más")}`);
  };

  seccion("🔴 *Sin descarga del SAT*", g.sat.map((s) => `${s.nombre}: ${MOTIVO_CORTO[s.motivo]}`));
  seccion(
    "⚠️ *Críticos*",
    g.criticas.map((c) => `${c.nombre}: ${plural(c.criticos, "crítico")}${c.resto > 0 ? ` + ${plural(c.resto, "pendiente")}` : ""}`),
  );
  seccion("🟡 *Pendientes*", g.pendientes.map((p) => `${p.nombre}: ${p.hallazgos}`));
  seccion("📋 *Cierre guiado*", g.cierre.map((c) => `${c.nombre}: ${c.linea}`));

  out.push("");
  if (g.alCorriente === g.total) out.push(`✅ Todas al corriente`);
  else if (g.alCorriente > 0) out.push(`✅ ${g.alCorriente} al corriente`);
  out.push(`📅 Declaraciones de ${textoDeclaracion(hoy)}`);
  out.push("", "_Escríbeme el nombre de una empresa para ver el detalle._");
  return out.join("\n");
}

/** Tope de {{1}}: WhatsApp limita el cuerpo de la plantilla (~1,024 con el texto fijo). */
const MAX_LINEA = 850;

/** Limpia una variable de plantilla: sin saltos/tabs/4+ espacios ni punto final. */
function limpiarVariable(s: string, max = MAX_LINEA): string {
  let v = s.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  if (v.length > max) v = v.slice(0, max - 1).replace(/\s+\S*$/, "") + "…";
  return v.replace(/[.\s]+$/, "");
}

/**
 * El resumen en UNA línea para {{1}} de la plantilla v1 («Buenos días. Resumen
 * de tu cartera de Contabilidad OS: {{1}}. Responde con el nombre…»). Las
 * variables no admiten saltos de línea, así que se agrupa POR TIPO con un emoji
 * por bloque en vez de empresa por empresa. Devuelve null si no hay empresas.
 */
export function formatCarteraDigestSummaryLine(
  empresas: ReadonlyArray<EmpresaResumen>,
  cierre: ReadonlyArray<LineaCierre> = [],
  hoy: Date = new Date(),
): string | null {
  if (empresas.length === 0) return null;
  const v = formatCarteraDigestVariables(empresas, cierre, hoy)!;
  const partes: string[] = [];
  if (hay(v.sat)) partes.push(`🔴 ${v.sat}`);
  if (hay(v.criticos)) partes.push(`⚠️ Críticos: ${v.criticos}`);
  if (hay(v.pendientes)) partes.push(`🟡 Pendientes: ${v.pendientes}`);
  partes.push(`✅ ${v.alCorriente} al corriente`);
  partes.push(`📅 ${v.declaracion}`);
  return limpiarVariable(partes.join(" · "));
}
const NINGUNO = "ninguno";
const hay = (s: string) => s !== NINGUNO;

export interface DigestVariables {
  sat: string;
  criticos: string;
  pendientes: string;
  alCorriente: string;
  declaracion: string;
}

/**
 * Variables de la plantilla v2 (multilínea, con las secciones fijas en el
 * texto aprobado). Ninguna puede ir vacía: Meta rechaza variables vacías, así
 * que un bloque sin nada lleva «ninguno».
 */
export function formatCarteraDigestVariables(
  empresas: ReadonlyArray<EmpresaResumen>,
  cierre: ReadonlyArray<LineaCierre> = [],
  hoy: Date = new Date(),
): DigestVariables | null {
  if (empresas.length === 0) return null;
  const gr = agrupar(empresas, cierre);
  const motivos = new Set(gr.sat.map((s) => s.motivo));
  const sat = gr.sat.length === 0
    ? NINGUNO
    : motivos.size === 1
      ? `${MOTIVO_CORTO[gr.sat[0].motivo]}: ${lista(gr.sat.map((s) => s.nombre), 4)}`
      : lista(gr.sat.map((s) => `${s.nombre} (${MOTIVO_CORTO[s.motivo]})`), 4);
  const criticos = gr.criticas.length === 0 ? NINGUNO : lista(gr.criticas.map((c) => `${c.nombre} (${c.criticos})`), 4);
  // El aviso del cierre se pega a su empresa si ya aparece con hallazgos.
  const avisos = new Map<string, string[]>();
  for (const c of gr.cierre) avisos.set(c.nombre, [...(avisos.get(c.nombre) ?? []), c.linea.charAt(0).toLowerCase() + c.linea.slice(1)]);
  const pend = gr.pendientes.map((p) => {
    const a = avisos.get(p.nombre);
    avisos.delete(p.nombre);
    return a ? `${p.nombre} (${p.hallazgos}; ${a.join("; ")})` : `${p.nombre} (${p.hallazgos})`;
  });
  for (const [nombre, a] of avisos) pend.push(`${nombre} (${a.join("; ")})`);
  const pendientes = pend.length === 0 ? NINGUNO : lista(pend, 4);
  return {
    sat: limpiarVariable(sat, 300),
    criticos: limpiarVariable(criticos, 300),
    pendientes: limpiarVariable(pendientes, 300),
    alCorriente: String(gr.alCorriente),
    declaracion: limpiarVariable(`declaraciones de ${textoDeclaracion(hoy)}`, 120),
  };
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

/** Margen bajo las 24h de la ventana de servicio para no rozar el corte. */
const VENTANA_MS = 23.5 * 3600_000;

/** ¿La persona escribió por WhatsApp en las últimas ~24h? (freeform permitido). */
export async function dentroDeVentana(linkId: string, ahora: Date = new Date()): Promise<boolean> {
  const m = await prisma.whatsappMessage.findFirst({
    where: { role: "USER", conversation: { linkId }, createdAt: { gte: new Date(ahora.getTime() - VENTANA_MS) } },
    select: { id: true },
  });
  return m !== null;
}

export interface DigestFormatos {
  texto: string;
  linea: string;
  variables: DigestVariables;
}

/**
 * Envía el resumen a un número, eligiendo el mejor formato entregable:
 *   1. Dentro de la ventana de 24h → freeform multilínea completo.
 *   2. `TWILIO_DIGEST_TEMPLATE_V2_SID` → plantilla multilínea por secciones.
 *   3. `TWILIO_DIGEST_TEMPLATE_SID` → plantilla v1 de una línea en {{1}}.
 *   4. Sin plantilla → freeform (Meta lo rechaza fuera de ventana; se registra).
 * Devuelve true si se envió, false si se omitió/falló.
 */
export async function sendCarteraDigest(
  phoneE164: string,
  f: DigestFormatos,
  enVentana = false,
): Promise<boolean> {
  const v2 = process.env.TWILIO_DIGEST_TEMPLATE_V2_SID;
  const v1 = process.env.TWILIO_DIGEST_TEMPLATE_SID;
  try {
    if (enVentana || (!v2 && !v1)) {
      await sendWhatsappMessage(phoneE164, f.texto);
    } else if (v2) {
      const v = f.variables;
      await sendWhatsappTemplate(phoneE164, v2, {
        "1": v.sat, "2": v.criticos, "3": v.pendientes, "4": v.alCorriente, "5": v.declaracion,
      });
    } else {
      await sendWhatsappTemplate(phoneE164, v1!, { "1": f.linea });
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
    select: { id: true, phoneE164: true, userId: true },
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
      const variables = formatCarteraDigestVariables(resumen, cierre);
      if (!texto || !linea || !variables) {
        omitidos++;
        continue;
      }
      const enVentana = await dentroDeVentana(link.id).catch(() => false);
      const ok = await sendCarteraDigest(link.phoneE164, { texto, linea, variables }, enVentana);
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
