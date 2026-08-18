// ─────────────────────────────────────────────────────────────────────────────
// RESUMEN PARA LA TARJETA DE PENDIENTES DEL TABLERO
//
// `evaluarChecks` (ce-readiness.ts) responde "¿es confiable la CE?" con la
// lista COMPLETA de checks — la vista de diagnóstico. La tarjeta del tablero
// contesta otra pregunta: "¿qué me falta para cerrar el mes?", y ahí sólo
// estorban los checks que ya están en verde. Esto reordena esa misma verdad:
//
//   • se queda con lo accionable (warn/error) y cuenta lo listo como progreso;
//   • los ERRORES van primero: bloquean el cierre, los warns sólo lo ensucian.
//     Dentro del mismo estado se respeta el orden original, que sigue el flujo
//     real del mes (CFDIs → banco → clasificar → cuadre → posteo).
//
// VIVE EN SU PROPIO ARCHIVO a propósito. Lo consume un componente de cliente,
// y `ce-readiness.ts` importa `prisma` y el motor de posteo en su primera
// línea: importar `resumirCierre` desde allá arrastraría Prisma entero al
// bundle del navegador. Aquí el único vínculo con ese módulo es `import type`,
// que TypeScript borra al compilar — no queda import en runtime.
// ─────────────────────────────────────────────────────────────────────────────

import type { ReadinessCheck, ReadinessResult } from "./ce-readiness";

export type ResumenCierre = {
  /** Checks evaluados en total. */
  total: number;
  /** Checks en verde — el numerador del progreso. */
  listos: number;
  /** Lo accionable, con los bloqueantes al frente. */
  pendientes: ReadinessCheck[];
  /** Cuántos pendientes son ERROR (impiden cerrar, no sólo ensucian). */
  bloqueantes: number;
  /** No queda nada accionable: el mes se puede cerrar. */
  todoListo: boolean;
};

export function resumirCierre(result: ReadinessResult): ResumenCierre {
  const total = result.checks.length;
  const listos = result.checks.filter((c) => c.estado === "ok").length;

  // Sólo los errores suben; el resto conserva su posición relativa. `sort` de
  // JS es estable desde ES2019, así que basta con puntuar error=0, warn=1.
  const pendientes = result.checks
    .filter((c) => c.estado !== "ok")
    .sort((a, b) => (a.estado === "error" ? 0 : 1) - (b.estado === "error" ? 0 : 1));

  const bloqueantes = pendientes.filter((c) => c.estado === "error").length;

  return { total, listos, pendientes, bloqueantes, todoListo: pendientes.length === 0 };
}
