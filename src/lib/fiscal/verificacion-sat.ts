// ─────────────────────────────────────────────────────────────────────────────
// Verificación contra el SAT — el "fire test" de dogfooding en una sola pantalla.
//
// Para una empresa y un mes CERRADO, pone lado a lado lo que calcula/genera el
// app contra la VERDAD ya presentada al SAT, y dictamina coincide / diverge /
// incompleto. Tres comparaciones:
//   1) Balanza del libro vivo  vs  balanza (BCE) que el SAT tiene (vía Syntage).
//   2) IVA del periodo (computeTaxPosition)  vs  IVA mensual presentado.
//   3) ISR provisional (computeTaxPosition)  vs  ISR provisional presentado.
//
// La verdad de (1) la da Syntage automáticamente. La de (2) y (3) sale de la
// declaración FILED capturada (acuse); si no está capturada, esa línea queda
// "sin_referencia" — no podemos verificar lo que no tenemos.
//
// La lógica de veredicto es PURA (sin DB) para poder probarla; el orquestador
// sólo la alimenta.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "@/lib/prisma";
import { computeTaxPosition } from "@/lib/impuestos";
import { evaluarReadinessCE, type ReadinessResult } from "@/lib/contabilidad/ce-readiness";
import { reconciliarCEEmpresa } from "@/lib/contabilidad/ce-reconciliacion";

/** Tolerancia en pesos: diferencias de hasta $1 se consideran redondeo. */
export const TOLERANCIA_PESOS = 1;

export type LineaVerdict = "ok" | "diverge" | "sin_referencia";

export interface VerificacionLinea {
  clave: string;
  titulo: string;
  /** Lo que dice el app (null si la línea no es una cifra única). */
  appValor: number | null;
  /** La verdad presentada al SAT (null si no la tenemos). */
  satValor: number | null;
  /** |app − sat| cuando ambas son comparables; null si no. */
  diff: number | null;
  verdict: LineaVerdict;
  detalle: string;
}

export type VeredictoGlobal = "coincide" | "diverge" | "incompleto";

export interface VerificacionSatResult {
  companyId: string;
  periodo: string;
  veredicto: VeredictoGlobal;
  lineas: VerificacionLinea[];
  readiness: ReadinessResult;
}

/**
 * Clasifica una línea numérica: si no hay referencia del SAT → sin_referencia;
 * si la diferencia supera la tolerancia → diverge; si no → ok. PURA.
 */
export function clasificarLinea(
  appValor: number | null,
  satValor: number | null,
  tol = TOLERANCIA_PESOS
): { diff: number | null; verdict: LineaVerdict } {
  if (satValor == null) return { diff: null, verdict: "sin_referencia" };
  const diff = Math.abs((appValor ?? 0) - satValor);
  return { diff, verdict: diff > tol ? "diverge" : "ok" };
}

/**
 * Veredicto global a partir de las líneas. PURA. Reglas:
 *   • Si alguna línea DIVERGE → "diverge" (lo más importante: hay un desajuste).
 *   • Si no diverge ninguna pero falta alguna referencia → "incompleto"
 *     (no pudimos verificar todo; típicamente falta capturar el acuse).
 *   • Si todas las líneas son comparables y ninguna diverge → "coincide".
 */
export function construirVeredicto(lineas: ReadonlyArray<VerificacionLinea>): VeredictoGlobal {
  if (lineas.some((l) => l.verdict === "diverge")) return "diverge";
  if (lineas.length === 0 || lineas.some((l) => l.verdict === "sin_referencia")) return "incompleto";
  return "coincide";
}

/**
 * Corre la verificación de una empresa para un periodo "YYYY-MM". SÓLO LECTURA
 * del libro (la conciliación CE no escribe el ledger; sí puede abrir un hallazgo
 * idempotente, lo cual es deseable). Los fallos de Syntage degradan a
 * "sin_referencia", no rompen la verificación.
 */
export async function verificarContraSat(
  companyId: string,
  periodo: string
): Promise<VerificacionSatResult> {
  const m = /^(\d{4})-(\d{2})$/.exec(periodo.trim());
  if (!m) throw new Error(`Periodo inválido: "${periodo}" (se espera YYYY-MM)`);
  const year = Number(m[1]);
  const month = Number(m[2]);

  const [pos, readiness, ivaDecl, isrDecl, ceRecon] = await Promise.all([
    computeTaxPosition(companyId, year, month),
    evaluarReadinessCE(companyId, year, month),
    prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "IVA_MENSUAL", periodo, status: "FILED" },
      select: { ivaPagar: true, ivaSaldoFavor: true },
    }),
    prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "ISR_PROVISIONAL", periodo, status: "FILED" },
      select: { isrPagar: true },
    }),
    reconciliarCEEmpresa(companyId, periodo).catch(() => null),
  ]);

  const lineas: VerificacionLinea[] = [];

  // ── 1. Balanza (libro) vs balanza del SAT (CE) ──────────────────────────────
  if (!ceRecon || ceRecon.diff == null) {
    lineas.push({
      clave: "ce_balanza",
      titulo: "Balanza del libro vs SAT (Contabilidad Electrónica)",
      appValor: null,
      satValor: null,
      diff: null,
      verdict: "sin_referencia",
      detalle:
        ceRecon?.error ??
        "El SAT aún no tiene la balanza del mes en Syntage, o la empresa no está habilitada para CE.",
    });
  } else {
    const d = ceRecon.diff;
    const totalDesajustes =
      d.discrepancias.length + d.faltantesEnLibro.length + d.faltantesEnSat.length;
    lineas.push({
      clave: "ce_balanza",
      titulo: "Balanza del libro vs SAT (Contabilidad Electrónica)",
      appValor: null,
      satValor: null,
      diff: null,
      verdict: totalDesajustes === 0 ? "ok" : "diverge",
      detalle:
        totalDesajustes === 0
          ? `${d.cuentasComparadas} cuentas comparadas, todas cuadran con el SAT.`
          : `${d.discrepancias.length} con saldo distinto, ${d.faltantesEnLibro.length} faltan en el libro, ${d.faltantesEnSat.length} faltan en el SAT (de ${d.cuentasComparadas} cuentas).`,
    });
  }

  // ── 2. IVA del periodo: app vs presentado ───────────────────────────────────
  // Neto firmado: a pagar positivo, saldo a favor negativo (compara ambas direcciones).
  const appIvaNeto = (pos.iva.pagar ?? 0) - (pos.iva.saldoAFavor ?? 0);
  const satIvaNeto =
    ivaDecl == null ? null : (ivaDecl.ivaPagar ?? 0) - (ivaDecl.ivaSaldoFavor ?? 0);
  {
    const c = clasificarLinea(appIvaNeto, satIvaNeto);
    lineas.push({
      clave: "iva",
      titulo: "IVA del periodo",
      appValor: appIvaNeto,
      satValor: satIvaNeto,
      diff: c.diff,
      verdict: c.verdict,
      detalle:
        satIvaNeto == null
          ? "No hay declaración de IVA presentada capturada para el mes. Sube el acuse para comparar."
          : c.verdict === "ok"
            ? "Coincide con lo presentado."
            : "Difiere de lo presentado.",
    });
  }

  // ── 3. ISR provisional: app vs presentado ───────────────────────────────────
  const appIsr = pos.isr.isrPagar ?? 0;
  const satIsr = isrDecl == null ? null : isrDecl.isrPagar ?? 0;
  {
    const c = clasificarLinea(appIsr, satIsr);
    lineas.push({
      clave: "isr",
      titulo: "ISR provisional",
      appValor: appIsr,
      satValor: satIsr,
      diff: c.diff,
      verdict: c.verdict,
      detalle:
        satIsr == null
          ? "No hay declaración de ISR provisional presentada capturada para el mes. Sube el acuse para comparar."
          : c.verdict === "ok"
            ? "Coincide con lo presentado."
            : "Difiere de lo presentado.",
    });
  }

  return {
    companyId,
    periodo,
    veredicto: construirVeredicto(lineas),
    lineas,
    readiness,
  };
}
