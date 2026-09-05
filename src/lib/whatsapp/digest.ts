// ─────────────────────────────────────────────────────────────────────────────
// Resumen diario de la cartera por WhatsApp ("buenos días, esto tienes hoy").
//
// El usuario activa la preferencia `WhatsappLink.digestOptIn` desde Ajustes; este
// módulo es lo que de verdad ENVÍA el mensaje matutino. Para cada link VERIFICADO
// con la preferencia activa arma un resumen de los hallazgos ABIERTOS en todas
// las empresas que el usuario puede ver y lo manda por WhatsApp.
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

/** Resumen por empresa para el formateador (puro). */
export interface EmpresaResumen {
  razonSocial: string;
  hallazgos: number;
  criticos: number;
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
    .filter((e) => e.hallazgos > 0)
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
    return `- ${e.razonSocial}: ${e.hallazgos} hallazgo${e.hallazgos === 1 ? "" : "s"}${crit}`;
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

/**
 * Resumen de UNA sola línea (sin saltos de línea) para la variable {{1}} de la
 * plantilla de WhatsApp. Las plantillas NO admiten variables con saltos de línea
 * ni tabs, así que el cuerpo multilínea va por el camino freeform y este resumen
 * compacto por el camino plantilla. Devuelve null si no hay empresas.
 */
export function formatCarteraDigestSummaryLine(
  empresas: ReadonlyArray<EmpresaResumen>
): string | null {
  if (empresas.length === 0) return null;
  const conPendientes = empresas.filter((e) => e.hallazgos > 0);
  const criticas = conPendientes.filter((e) => e.criticos > 0).length;
  const alCorriente = empresas.length - conPendientes.length;

  if (conPendientes.length === 0) {
    const n = empresas.length;
    return `${n} empresa${n === 1 ? "" : "s"} al corriente, sin hallazgos abiertos`;
  }
  const crit = criticas > 0 ? ` (${criticas} con críticos)` : "";
  const cp = conPendientes.length;
  return `${cp} empresa${cp === 1 ? "" : "s"} con pendientes${crit} y ${alCorriente} al corriente`;
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

  return companies.map((c) => ({
    razonSocial: c.razonSocial,
    hallazgos: porEmpresa.get(c.id)?.hallazgos ?? 0,
    criticos: porEmpresa.get(c.id)?.criticos ?? 0,
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
    where: { verifiedAt: { not: null }, digestOptIn: true },
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
      const linea = formatCarteraDigestSummaryLine(resumen);
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
