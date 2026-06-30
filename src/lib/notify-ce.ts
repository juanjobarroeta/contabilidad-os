import { sendPushToCompany } from "./push";
import { prisma } from "./prisma";
import { planIncluyeSyntage } from "./planes";
import { generateBalanzaXml, generateCatalogoXml } from "./contabilidad/coe-xml";
import {
  reconciliarCEEmpresa,
  nudgeCEPresentacion,
  parsePeriodo,
  periodoMesAnterior,
  type ReconciliarResult,
} from "./contabilidad/ce-reconciliacion";
import type { SyntageClient } from "./fiscal/cumplimiento/syntage/client";

// ─────────────────────────────────────────────────────────────────────────────
// Nudge MENSUAL de "presentación asistida" de la Contabilidad Electrónica.
//
// Tras cerrar el mes anterior: (1) ASEGURA que los XML del Anexo 24 estén
// generados desde el libro VIVO (catálogo + balanza) — sólo se generan, NUNCA se
// envían al SAT; (2) REUSA la conciliación existente (reconciliarCEEmpresa) para
// saber si cuadra contra la balanza del SAT; (3) EMPUJA un push a quienes operan
// la empresa: "lista para presentar" (deep link a descargar/presentar) o "no
// cuadra en N cuentas — revísala antes de presentar".
//
// Sólo empresas con plan Syntage y ya arrancadas (ceBootstrapAt != null). No hay
// API de envío al SAT: esto es generar + guiar, jamás auto-presentar.
// ─────────────────────────────────────────────────────────────────────────────

export interface NudgeCEEmpresaResult {
  companyId: string;
  periodo: string;
  /** XML generados (catálogo + balanza) desde el libro vivo. */
  generado: boolean;
  /** La conciliación pudo correr (había balanza del SAT para comparar). */
  conciliado: boolean;
  /** El resultado cuadra contra el SAT. */
  cuadra: boolean;
  /** Pushes enviados (suma de suscripciones de todos los usuarios con acceso). */
  notificados: number;
  skipped?: boolean;
  error?: string;
}

/**
 * Asegura los XML del Anexo 24 del periodo desde el libro vivo. Idempotente: las
 * funciones generate* simplemente recomputan el XML (y refrescan el registro de
 * envío de la balanza); NO escriben en el ledger ni envían nada al SAT. Se ejecuta
 * best-effort: si la generación falla, no detiene el nudge.
 */
async function asegurarXmlAnexo24(companyId: string, year: number, month: number): Promise<boolean> {
  await generateCatalogoXml({ companyId, year, month });
  await generateBalanzaXml({ companyId, year, month });
  return true;
}

/**
 * Genera + concilia + empuja el nudge de presentación de la CE de UNA empresa
 * para un periodo "YYYY-MM". Reusa reconciliarCEEmpresa (sólo lectura del ledger)
 * y sendPushToCompany (miembros + despacho + operadores). No-op silencioso si la
 * empresa no es elegible o si el SAT aún no tiene la balanza del mes.
 */
export async function notificarCEEmpresa(
  companyId: string,
  periodo: string = periodoMesAnterior(),
  opts: { client?: SyntageClient } = {},
): Promise<NudgeCEEmpresaResult> {
  const { year, month } = parsePeriodo(periodo);

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { tier: true, ceBootstrapAt: true },
  });
  if (!company) {
    return { companyId, periodo, generado: false, conciliado: false, cuadra: false, notificados: 0, error: "Empresa no encontrada" };
  }
  // Sólo plan Syntage y ya arrancada (la CE está activa).
  if (!planIncluyeSyntage(company.tier) || company.ceBootstrapAt == null) {
    return { companyId, periodo, generado: false, conciliado: false, cuadra: false, notificados: 0, skipped: true };
  }

  // (1) Asegura los XML del periodo desde el libro vivo (best-effort).
  let generado = false;
  try {
    generado = await asegurarXmlAnexo24(companyId, year, month);
  } catch (e) {
    console.error(`[notify-ce] generar XML ${companyId} ${periodo} falló:`, e);
  }

  // (2) Reusa la conciliación existente (sólo lectura) vs la balanza del SAT.
  const recon: ReconciliarResult = await reconciliarCEEmpresa(companyId, periodo, { client: opts.client });
  if (!recon.diff) {
    // Sin balanza del SAT que comparar (o no elegible): nada que empujar todavía.
    return { companyId, periodo, generado, conciliado: false, cuadra: false, notificados: 0, skipped: true, error: recon.error };
  }

  // (3) Empuja el nudge a quienes operan la empresa.
  const nudge = nudgeCEPresentacion(recon.diff);
  const push = await sendPushToCompany(
    companyId,
    { title: nudge.title, body: nudge.body, url: nudge.url, tag: nudge.tag },
    "declaraciones",
  );

  return {
    companyId,
    periodo,
    generado,
    conciliado: true,
    cuadra: recon.diff.discrepancias.length === 0 && recon.diff.faltantesEnLibro.length === 0 && recon.diff.faltantesEnSat.length === 0,
    notificados: push.sent,
  };
}

/**
 * Recorre TODAS las empresas elegibles (plan Syntage + ceBootstrapAt != null)
 * generando + conciliando + empujando el nudge de presentación. Best-effort: el
 * error de una empresa no detiene a las demás.
 */
export async function notificarCETodas(
  periodo: string = periodoMesAnterior(),
): Promise<{ empresas: number; cuadran: number; noCuadran: number; notificados: number; errores: number; periodo: string }> {
  const { SyntageClient } = await import("./fiscal/cumplimiento/syntage/client");
  const client = new SyntageClient();

  const companies = await prisma.company.findMany({
    where: { ceBootstrapAt: { not: null }, tier: { not: "ASISTENTE" } },
    select: { id: true },
  });

  let cuadran = 0;
  let noCuadran = 0;
  let notificados = 0;
  let errores = 0;
  for (const c of companies) {
    try {
      const r = await notificarCEEmpresa(c.id, periodo, { client });
      if (r.error) errores++;
      if (r.conciliado) {
        if (r.cuadra) cuadran++;
        else noCuadran++;
      }
      notificados += r.notificados;
    } catch (e) {
      errores++;
      console.error(`[notify-ce] empresa ${c.id} falló:`, e);
    }
  }

  return { empresas: companies.length, cuadran, noCuadran, notificados, errores, periodo };
}
