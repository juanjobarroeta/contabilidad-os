// ─────────────────────────────────────────────────────────────────────────────
// Guardia de uso de IA: UNA puerta para TODO lo que gasta modelo.
//
// Antes cada función tenía (o no) su propio tope: el chat medía sólo "ai.chat",
// WhatsApp sólo "whatsapp.*", y el resto (leer CSF, acuses, estados de cuenta,
// documentos de empleados, categorizar, auditor, crédito) no tenía ninguno. Con
// esto, cualquier endpoint de IA llama `asegurarUsoIA` ANTES de invocar el
// modelo y la decisión sale de tres sumas baratas sobre CostEvent:
//
//   1. Gasto del MES de la EMPRESA (todas las categorías LLM/OPENAI) contra el
//      techo de su tier + el uso extra comprado/otorgado para ese mes
//      (AiCreditGrant). Si el dueño está en PRUEBA, el techo es el de prueba.
//   2. Gasto del MES del USUARIO sin empresa (onboarding) contra un techo fijo.
//   3. OPERACIONES del DÍA del USUARIO (todas las funciones) contra un tope fijo.
//
// La DECISIÓN es pura (decidirUsoIA) para probarse sin DB; las consultas sólo
// la alimentan. El chat conserva además su tope diario de mensajes por usuario.
// ─────────────────────────────────────────────────────────────────────────────

import type { CompanyPlan } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  IA_OPERACIONES_DIARIAS_USUARIO,
  IA_USD_MENSUAL_PRUEBA,
  IA_USD_MENSUAL_SIN_EMPRESA,
  iaUsdMensualEmpresa,
} from "@/lib/planes";

const TZ = "America/Mexico_City";

export const MENSAJE_TOPE_EMPRESA =
  "Esta empresa alcanzó su límite mensual de uso de inteligencia artificial. Puedes ampliar el límite en Configuración → Facturación o esperar al siguiente mes.";
export const MENSAJE_TOPE_USUARIO_DIA =
  "Alcanzaste tu límite diario de operaciones con inteligencia artificial. Inténtalo de nuevo mañana.";
export const MENSAJE_TOPE_SIN_EMPRESA =
  "Alcanzaste el límite de documentos que se pueden leer con inteligencia artificial antes de registrar una empresa. Termina el registro para continuar.";

export type DecisionIA =
  | { ok: true }
  | { ok: false; status: 429; motivo: "empresa" | "usuario_dia" | "sin_empresa"; mensaje: string };

/** Decisión PURA a partir de las sumas. */
export function decidirUsoIA(input: {
  /** Gasto del mes de la empresa (USD). undefined = operación sin empresa. */
  gastoEmpresaMesUsd?: number;
  /** Techo del mes de la empresa (USD), ya con el extra sumado. */
  topeEmpresaMesUsd?: number;
  /** Gasto del mes del usuario en operaciones sin empresa (USD). */
  gastoUsuarioSinEmpresaMesUsd?: number;
  /** Operaciones de IA del usuario hoy (todas las funciones). */
  operacionesUsuarioHoy: number;
}): DecisionIA {
  if (input.operacionesUsuarioHoy >= IA_OPERACIONES_DIARIAS_USUARIO) {
    return { ok: false, status: 429, motivo: "usuario_dia", mensaje: MENSAJE_TOPE_USUARIO_DIA };
  }
  if (input.gastoEmpresaMesUsd !== undefined && input.topeEmpresaMesUsd !== undefined) {
    if (input.gastoEmpresaMesUsd >= input.topeEmpresaMesUsd) {
      return { ok: false, status: 429, motivo: "empresa", mensaje: MENSAJE_TOPE_EMPRESA };
    }
  }
  if (input.gastoUsuarioSinEmpresaMesUsd !== undefined) {
    if (input.gastoUsuarioSinEmpresaMesUsd >= IA_USD_MENSUAL_SIN_EMPRESA) {
      return { ok: false, status: 429, motivo: "sin_empresa", mensaje: MENSAJE_TOPE_SIN_EMPRESA };
    }
  }
  return { ok: true };
}

/** Techo mensual efectivo de una empresa: tier propio (o prueba) + extra del mes. */
export function topeMensualEmpresaUsd(input: {
  tier: CompanyPlan;
  duenoEnPrueba: boolean;
  extraUsd: number;
}): number {
  const base = input.duenoEnPrueba ? IA_USD_MENSUAL_PRUEBA : iaUsdMensualEmpresa(input.tier);
  return base + Math.max(0, input.extraUsd);
}

/** "YYYY-MM" del mes actual en hora de México (clave de AiCreditGrant.periodo). */
export function periodoActualMx(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit" }).format(now);
}

/** Inicio del mes natural actual (día 1, 00:00) en hora de México, como UTC. */
export function startOfMonthMx(now = new Date()): Date {
  return new Date(`${periodoActualMx(now)}-01T06:00:00.000Z`);
}

/** Inicio del día actual (00:00) en hora de México, como UTC (CDMX = UTC-6, sin DST). */
export function startOfDayMx(now = new Date()): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(`${ymd}T06:00:00.000Z`);
}

const CATEGORIAS_IA = ["LLM", "OPENAI"];

/**
 * ¿El dueño de la empresa está en periodo de prueba? Empresa de despacho: el
 * OWNER del despacho; independiente: el OWNER de la empresa. Si no se puede
 * determinar, se asume que NO (aplica el tope del tier, no el de prueba).
 */
async function duenoEnPrueba(companyId: string, despachoId: string | null): Promise<boolean> {
  if (despachoId) {
    const owner = await prisma.despachoMember.findFirst({
      where: { despachoId, role: "OWNER" },
      select: { user: { select: { subscriptionStatus: true } } },
    });
    return owner?.user.subscriptionStatus === "TRIALING";
  }
  const owner = await prisma.companyMember.findFirst({
    where: { companyId, role: "OWNER" },
    select: { user: { select: { subscriptionStatus: true } } },
  });
  return owner?.user.subscriptionStatus === "TRIALING";
}

export interface EstadoIAEmpresa {
  companyId: string;
  tier: CompanyPlan;
  duenoEnPrueba: boolean;
  gastoMesUsd: number;
  extraMesUsd: number;
  topeMesUsd: number;
  periodo: string;
}

/** Gasto, extra y techo del mes de una empresa (para la guardia y para mostrarlo). */
export async function estadoIAEmpresa(companyId: string): Promise<EstadoIAEmpresa | null> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { tier: true, despachoId: true },
  });
  if (!company) return null;
  const periodo = periodoActualMx();
  const [gasto, extra, prueba] = await Promise.all([
    prisma.costEvent.aggregate({
      where: { companyId, categoria: { in: CATEGORIAS_IA }, occurredAt: { gte: startOfMonthMx() } },
      _sum: { costoMicroUsd: true },
    }),
    prisma.aiCreditGrant.aggregate({ where: { companyId, periodo }, _sum: { usd: true } }),
    duenoEnPrueba(companyId, company.despachoId),
  ]);
  const gastoMesUsd = (gasto._sum.costoMicroUsd ?? 0) / 1_000_000;
  const extraMesUsd = extra._sum.usd ?? 0;
  return {
    companyId,
    tier: company.tier,
    duenoEnPrueba: prueba,
    gastoMesUsd,
    extraMesUsd,
    topeMesUsd: topeMensualEmpresaUsd({ tier: company.tier, duenoEnPrueba: prueba, extraUsd: extraMesUsd }),
    periodo,
  };
}

async function operacionesUsuarioHoy(userId: string): Promise<number> {
  return prisma.costEvent.count({
    where: { userId, categoria: { in: CATEGORIAS_IA }, occurredAt: { gte: startOfDayMx() } },
  });
}

async function gastoUsuarioSinEmpresaMesUsd(userId: string): Promise<number> {
  const agg = await prisma.costEvent.aggregate({
    where: { userId, companyId: null, categoria: { in: CATEGORIAS_IA }, occurredAt: { gte: startOfMonthMx() } },
    _sum: { costoMicroUsd: true },
  });
  return (agg._sum.costoMicroUsd ?? 0) / 1_000_000;
}

/**
 * Comprueba los topes ANTES de invocar el modelo. `companyId` null = operación
 * sin empresa (onboarding). Nunca lanza: ante un fallo de DB permite (la guardia
 * es de costo, no de seguridad) y lo deja en consola.
 */
export async function asegurarUsoIA(opts: { userId: string; companyId: string | null }): Promise<DecisionIA> {
  try {
    if (opts.companyId) {
      const [estado, hoy] = await Promise.all([estadoIAEmpresa(opts.companyId), operacionesUsuarioHoy(opts.userId)]);
      return decidirUsoIA({
        gastoEmpresaMesUsd: estado?.gastoMesUsd,
        topeEmpresaMesUsd: estado?.topeMesUsd,
        operacionesUsuarioHoy: hoy,
      });
    }
    const [sinEmpresa, hoy] = await Promise.all([gastoUsuarioSinEmpresaMesUsd(opts.userId), operacionesUsuarioHoy(opts.userId)]);
    return decidirUsoIA({ gastoUsuarioSinEmpresaMesUsd: sinEmpresa, operacionesUsuarioHoy: hoy });
  } catch (e) {
    console.error("[ia/guardia] no se pudo evaluar el tope:", e instanceof Error ? e.message : e);
    return { ok: true };
  }
}

/** Respuesta HTTP estándar cuando la guardia niega. */
export function respuestaTopeIA(d: Exclude<DecisionIA, { ok: true }>): NextResponse {
  return NextResponse.json({ error: d.mensaje, codigo: `IA_TOPE_${d.motivo.toUpperCase()}` }, { status: d.status });
}
