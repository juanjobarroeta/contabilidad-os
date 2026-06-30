import { sendPushToCompany } from "./push";
import { registrarYNotificar } from "./notificaciones";
import { prisma } from "./prisma";
import { empresasAccesiblesIds } from "./authz";
import { planIncluyeSyntage } from "./planes";
import { generateBalanzaXml, generateCatalogoXml } from "./contabilidad/coe-xml";
import {
  reconciliarCEEmpresa,
  construirNudgeCEAgregado,
  cuentasQueNoCuadran,
  parsePeriodo,
  periodoMesAnterior,
  type CEEmpresaEstado,
  type ReconciliarResult,
} from "./contabilidad/ce-reconciliacion";
import type { SyntageClient } from "./fiscal/cumplimiento/syntage/client";

// ─────────────────────────────────────────────────────────────────────────────
// Nudge MENSUAL de "presentación asistida" de la Contabilidad Electrónica.
//
// Tras cerrar el mes anterior: (1) ASEGURA que los XML del Anexo 24 estén
// generados desde el libro VIVO (catálogo + balanza) — sólo se generan, NUNCA se
// envían al SAT; (2) REUSA la conciliación existente (reconciliarCEEmpresa) para
// saber si cuadra contra la balanza del SAT; (3) EMPUJA el nudge.
//
// IMPORTANTE (carteras grandes): el push se AGREGA por USUARIO, no por empresa.
// Un despacho con 7 empresas recibe UN solo aviso ("4 listas; 1 por revisar:
// Zionx"), no 7. La generación + conciliación sí corre una vez por empresa.
//
// Sólo empresas con plan Syntage y ya arrancadas (ceBootstrapAt != null). No hay
// API de envío al SAT: esto es generar + guiar, jamás auto-presentar.
// ─────────────────────────────────────────────────────────────────────────────

export interface NudgeCEEmpresaResult {
  companyId: string;
  periodo: string;
  generado: boolean;
  conciliado: boolean;
  cuadra: boolean;
  notificados: number;
  skipped?: boolean;
  error?: string;
}

/** Cómputo por empresa (genera + concilia), SIN empujar. */
interface CEComputo {
  companyId: string;
  razonSocial: string;
  periodo: string;
  generado: boolean;
  conciliado: boolean;
  cuadra: boolean;
  cuentasNoCuadran: number;
  skipped?: boolean;
  error?: string;
}

/**
 * Asegura los XML del Anexo 24 del periodo desde el libro vivo. Idempotente: las
 * funciones generate* recomputan el XML (y refrescan el registro de envío de la
 * balanza); NO escriben en el ledger ni envían nada al SAT.
 */
async function asegurarXmlAnexo24(companyId: string, year: number, month: number): Promise<boolean> {
  await generateCatalogoXml({ companyId, year, month });
  await generateBalanzaXml({ companyId, year, month });
  return true;
}

/**
 * Genera + concilia la CE de UNA empresa (SIN empujar). Reusa reconciliarCEEmpresa
 * (sólo lectura del ledger). No-op (skipped) si la empresa no es elegible o si el
 * SAT aún no tiene la balanza del mes.
 */
async function computarCEEmpresa(
  companyId: string,
  periodo: string,
  client?: SyntageClient,
): Promise<CEComputo> {
  const { year, month } = parsePeriodo(periodo);
  const base = { companyId, periodo, generado: false, conciliado: false, cuadra: false, cuentasNoCuadran: 0 };

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { razonSocial: true, tier: true, ceBootstrapAt: true },
  });
  if (!company) return { ...base, razonSocial: "", error: "Empresa no encontrada" };
  if (!planIncluyeSyntage(company.tier) || company.ceBootstrapAt == null) {
    return { ...base, razonSocial: company.razonSocial, skipped: true };
  }

  let generado = false;
  try {
    generado = await asegurarXmlAnexo24(companyId, year, month);
  } catch (e) {
    console.error(`[notify-ce] generar XML ${companyId} ${periodo} falló:`, e);
  }

  const recon: ReconciliarResult = await reconciliarCEEmpresa(companyId, periodo, { client });
  if (!recon.diff) {
    return { ...base, razonSocial: company.razonSocial, generado, skipped: true, error: recon.error };
  }
  const cuadra =
    recon.diff.discrepancias.length === 0 &&
    recon.diff.faltantesEnLibro.length === 0 &&
    recon.diff.faltantesEnSat.length === 0;
  return {
    companyId,
    razonSocial: company.razonSocial,
    periodo,
    generado,
    conciliado: true,
    cuadra,
    cuentasNoCuadran: cuentasQueNoCuadran(recon.diff),
  };
}

/**
 * Genera + concilia + empuja el nudge de UNA empresa (uso individual/manual).
 * Una sola empresa → un solo push a quienes la operan (sin riesgo de avalancha).
 */
export async function notificarCEEmpresa(
  companyId: string,
  periodo: string = periodoMesAnterior(),
  opts: { client?: SyntageClient } = {},
): Promise<NudgeCEEmpresaResult> {
  const c = await computarCEEmpresa(companyId, periodo, opts.client);
  if (!c.conciliado) {
    return { companyId, periodo, generado: c.generado, conciliado: false, cuadra: false, notificados: 0, skipped: c.skipped, error: c.error };
  }
  const nudge = construirNudgeCEAgregado(periodo, [
    { razonSocial: c.razonSocial, cuadra: c.cuadra, cuentasNoCuadran: c.cuentasNoCuadran },
  ])!;
  const push = await sendPushToCompany(
    companyId,
    { title: nudge.title, body: nudge.body, url: nudge.url, tag: nudge.tag },
    "declaraciones",
  );
  return { companyId, periodo, generado: c.generado, conciliado: true, cuadra: c.cuadra, notificados: push.sent };
}

/**
 * Recorre TODAS las empresas elegibles: genera + concilia UNA vez por empresa, y
 * luego empuja UN solo nudge AGREGADO por usuario (across sus empresas accesibles).
 * Así un despacho recibe un aviso, no uno por empresa. Best-effort.
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

  // 1) Cómputo por empresa (una vez cada una).
  const computos: CEComputo[] = [];
  let errores = 0;
  for (const c of companies) {
    try {
      const r = await computarCEEmpresa(c.id, periodo, client);
      if (r.error) errores++;
      computos.push(r);
    } catch (e) {
      errores++;
      console.error(`[notify-ce] empresa ${c.id} falló:`, e);
    }
  }

  const conciliados = computos.filter((c) => c.conciliado);
  const cuadran = conciliados.filter((c) => c.cuadra).length;
  const noCuadran = conciliados.length - cuadran;

  // 2) Un solo push AGREGADO por usuario suscrito, sobre sus empresas accesibles.
  const porEmpresa = new Map(conciliados.map((c) => [c.companyId, c]));
  const subs = await prisma.pushSubscription.findMany({ select: { userId: true }, distinct: ["userId"] });
  let notificados = 0;
  for (const { userId } of subs) {
    try {
      const ids = await empresasAccesiblesIds(userId);
      const estados: CEEmpresaEstado[] = ids
        .map((id) => porEmpresa.get(id))
        .filter((c): c is CEComputo => Boolean(c))
        .map((c) => ({ razonSocial: c.razonSocial, cuadra: c.cuadra, cuentasNoCuadran: c.cuentasNoCuadran }));
      if (estados.length === 0) continue;
      const nudge = construirNudgeCEAgregado(periodo, estados);
      if (!nudge) continue;
      // Si alguna empresa no cuadra, es algo a revisar (warn); si todas cuadran,
      // es informativo. Pendiente a nivel cartera: sin companyId único.
      const hayPorRevisar = estados.some((e) => !e.cuadra);
      const r = await registrarYNotificar({
        recipientUserId: userId,
        categoria: "ce",
        severidad: hayPorRevisar ? "warn" : "info",
        titulo: nudge.title,
        cuerpo: nudge.body,
        url: nudge.url,
        dedupeKey: nudge.tag,
        categoriaPush: "declaraciones",
      });
      if (r.pushSent) notificados += 1;
    } catch {
      // no romper el lote por un usuario
    }
  }

  return { empresas: companies.length, cuadran, noCuadran, notificados, errores, periodo };
}
