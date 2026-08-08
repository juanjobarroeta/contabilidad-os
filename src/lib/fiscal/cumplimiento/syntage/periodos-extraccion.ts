// ─────────────────────────────────────────────────────────────────────────────
// Periodo histórico explícito por extractor de Syntage.
//
// Syntage cobra POR EXTRACCIÓN, no por año extraído — pedir 10 años cuesta lo
// mismo que pedir 2. El provision disparaba `createExtraction` SIN periodo y
// Syntage aplicaba su ventana default (caso real: las anuales de una empresa
// llegaron sólo de 2023 en adelante, con pérdidas de ejercicios previos
// invisibles). El tope de 5 años es una restricción de la descarga masiva de
// CFDI del SAT — NO aplica a declaraciones ni a Contabilidad Electrónica.
//
// Ventanas elegidas (costo de pedir más = 0; el costo real está en QUÉ hacemos
// con lo extraído):
//   • annual_tax_return  → 10 ejercicios: las pérdidas fiscales se amortizan
//     hasta 10 ejercicios (Art. 57 LISR); una anual vieja puede cargar un
//     remanente vigente. Parseo: 1 por año, acotado.
//   • monthly_tax_return → 5 años: el arrastre práctico (saldos a favor,
//     diciembre previo) no llega más atrás, y cada acuse mensual extra cuesta
//     un parseo de Claude en el backfill — aquí el costo NO es cero.
//   • electronic_accounting → desde 2015-01-01: la CE es obligatoria desde
//     2015 (Anexo 24); todo el histórico sirve para cotejar migraciones.
//   • invoice / tax_retention → null: el SAT sí topa CFDIs a 5 años; dejamos
//     el default de Syntage.
//   • tax_compliance / tax_status → null: son fotos puntuales, sin periodo.
// ─────────────────────────────────────────────────────────────────────────────

import type { Extractor } from "./client";

export const INICIO_CE = "2015-01-01";
export const ANIOS_ANUALES = 10;
export const ANIOS_MENSUALES = 5;

export function periodoHistorico(
  extractor: Extractor,
  hoy: Date,
): { from: string; to: string } | null {
  const to = hoy.toISOString().slice(0, 10);
  switch (extractor) {
    case "electronic_accounting":
      return { from: INICIO_CE, to };
    case "annual_tax_return":
      return { from: `${hoy.getUTCFullYear() - ANIOS_ANUALES}-01-01`, to };
    case "monthly_tax_return":
      return { from: `${hoy.getUTCFullYear() - ANIOS_MENSUALES}-01-01`, to };
    default:
      return null;
  }
}

/** `options` para createExtraction: `{ period }` o nada si el extractor es puntual. */
export function opcionesExtraccion(extractor: Extractor, hoy: Date): { period: { from: string; to: string } } | undefined {
  const period = periodoHistorico(extractor, hoy);
  return period ? { period } : undefined;
}
