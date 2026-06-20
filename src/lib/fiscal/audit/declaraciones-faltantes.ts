// ─────────────────────────────────────────────────────────────────────────────
// Declaraciones faltantes = cadena de arrastre incompleta. Si no tenemos los
// acuses previos no podemos arrastrar bien el saldo a favor de IVA, el saldo a
// favor / pagos provisionales de ISR ni el coeficiente — así que las cifras del
// mes pueden estar MAL. Lo elevamos a hallazgo del auditor (además del banner),
// reusando el detector declaracionesFaltantesEmpresa(). Un solo hallazgo
// agregado; el detalle y la captura viven en /declaraciones.
// ─────────────────────────────────────────────────────────────────────────────

import type { Hallazgo } from "./types";
import type { AcuseFaltante } from "@/lib/fiscal/cobertura-declaraciones";

/** One aggregate Hallazgo for the carryover-critical missing declaraciones
 *  (empty → no finding). Older anuales are historical, not carryover-blocking,
 *  so they don't raise a flag here — only on the capture screen. */
export function auditarDeclaracionesFaltantes(faltantes: AcuseFaltante[]): Hallazgo[] {
  const criticas = faltantes.filter((f) => f.critico);
  if (criticas.length === 0) return [];
  const etiquetas = criticas.map((f) => f.etiqueta);
  const muestra = etiquetas.slice(0, 8).join(", ") + (etiquetas.length > 8 ? "…" : "");
  return [
    {
      checkClave: "declaraciones.faltantes",
      severidad: "warn",
      mensaje: `Faltan ${criticas.length} declaración(es)/acuse(s) que afectan el arrastre del periodo. Sin ellas el saldo a favor de IVA, los pagos provisionales de ISR y el coeficiente de utilidad quedan incompletos — las cifras de este periodo pueden ser incorrectas.`,
      // Identidad estable por (tipo:periodo); cambia con el conjunto faltante.
      referencias: criticas.map((f) => `${f.tipo}:${f.periodo}`),
      fundamento: { ley: "LISR", articulo: "14" },
      sugerencia: `Captura los acuses en Declaraciones para completar el arrastre: ${muestra}.`,
    },
  ];
}
