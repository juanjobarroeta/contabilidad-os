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

/** One aggregate Hallazgo for all missing declaraciones (empty → no finding). */
export function auditarDeclaracionesFaltantes(faltantes: AcuseFaltante[]): Hallazgo[] {
  if (faltantes.length === 0) return [];
  const etiquetas = faltantes.map((f) => f.etiqueta);
  const muestra = etiquetas.slice(0, 8).join(", ") + (etiquetas.length > 8 ? "…" : "");
  return [
    {
      checkClave: "declaraciones.faltantes",
      severidad: "warn",
      mensaje: `Faltan ${faltantes.length} declaración(es)/acuse(s) por capturar. Sin ellas el arrastre de saldo a favor de IVA, saldo a favor y pagos provisionales de ISR, y el coeficiente de utilidad queda incompleto — las cifras de este periodo pueden ser incorrectas.`,
      // Identidad estable por (tipo:periodo); cambia con el conjunto faltante.
      referencias: faltantes.map((f) => `${f.tipo}:${f.periodo}`),
      fundamento: { ley: "LISR", articulo: "14" },
      sugerencia: `Captura los acuses en Declaraciones para completar el arrastre: ${muestra}.`,
    },
  ];
}
