// ─────────────────────────────────────────────────────────────────────────────
// EL ESTADO DE CADA PASO DEL FLUJO DE CIERRE.
//
// POR QUÉ EXISTE. El brief de UX pedía esto con todas sus letras:
//
//   «Estado por paso: listo / pendiente / bloqueado, siempre con el número que
//    importa ("43 movimientos sin conciliar"), NUNCA SÓLO UN ÍCONO.»
//
// Lo que se construyó fueron cinco <Link> con un número al lado y cero estado
// — menos que el mínimo que el brief prohibía. Una fila de pills horizontales
// es una barra de tabs: el usuario tiene que entrar a cada paso para averiguar
// si ahí hay trabajo, que es exactamente lo que el flujo venía a evitar.
//
// EL MOTOR YA EXISTÍA. `evaluarChecks` (ce-readiness.ts) ya contesta esto, y
// ya corre en producción — pero sólo se consumía en el TABLERO
// (PendientesDelCierre). O sea que el tablero sabía qué faltaba y la pantalla
// que uno abre para cerrar el mes no. Esto no calcula nada nuevo: reordena esa
// misma verdad por paso.
//
// VIVE EN SU PROPIO ARCHIVO, igual que cierre-resumen.ts y por la misma razón:
// lo consume un componente de cliente, y `ce-readiness.ts` importa prisma y el
// motor de posteo en su primera línea. Aquí el único vínculo es `import type`,
// que TypeScript borra al compilar — no queda import en runtime.
// ─────────────────────────────────────────────────────────────────────────────

import type { CheckEstado, ReadinessCheck, ReadinessResult } from "./ce-readiness";

export type ClavePaso = "cierre" | "conciliacion" | "divergencia" | "ajustes" | "entregables";

/**
 * Qué check alimenta a qué paso.
 *
 * El orden dentro de cada paso importa: el primero que esté en rojo es el que
 * se muestra. Un paso sin checks (entregables) no queda mudo — hereda si algo
 * anterior lo bloquea, que es más útil que decir «sin datos».
 */
const CHECKS_POR_PASO: Record<ClavePaso, string[]> = {
  cierre: ["cfdis", "capital_inicial"],
  conciliacion: ["banco", "sin_clasificar"],
  divergencia: ["cuadre"],
  ajustes: ["posteo"],
  entregables: [],
};

export interface EstadoPaso {
  clave: ClavePaso;
  /**
   * `listo` nada que hacer · `atencion` hay trabajo pero no impide avanzar ·
   * `bloquea` impide cerrar el mes · `espera` bloqueado por un paso anterior ·
   * `sin_datos` todavía no se puede evaluar.
   */
  estado: "listo" | "atencion" | "bloquea" | "espera" | "sin_datos";
  /**
   * EL NÚMERO QUE IMPORTA, listo para pintar: «43 movimiento(s) sin
   * clasificar», «Mes preliminar». Sale del `titulo` del check, que ya viene
   * redactado con su cifra — no se re-inventa el texto aquí.
   */
  detalle: string | null;
}

const PESO: Record<CheckEstado, number> = { error: 0, warn: 1, ok: 2 };

/** El check más grave de un paso; `null` si ninguno aplica al periodo. */
function peorCheck(checks: ReadinessCheck[], claves: string[]): ReadinessCheck | null {
  const propios = checks.filter((c) => claves.includes(c.clave));
  if (propios.length === 0) return null;
  return propios.reduce((a, b) => (PESO[a.estado] <= PESO[b.estado] ? a : b));
}

/**
 * El estado de los cinco pasos, en el orden del flujo.
 *
 * REGLA DE PROPAGACIÓN: un paso posterior a un bloqueo no se pinta en verde
 * aunque sus propios checks estén limpios — se marca `espera`. Decirle «listo»
 * a Entregables cuando la conciliación bloquea el posteo sería mentir sobre lo
 * único que el contador vino a saber: si ya puede declarar.
 */
export function estadoDeLosPasos(result: ReadinessResult | null): EstadoPaso[] {
  const orden: ClavePaso[] = ["cierre", "conciliacion", "divergencia", "ajustes", "entregables"];
  if (!result) {
    return orden.map((clave) => ({ clave, estado: "sin_datos" as const, detalle: null }));
  }

  let bloqueado = false;
  return orden.map((clave) => {
    const check = peorCheck(result.checks, CHECKS_POR_PASO[clave]);

    if (bloqueado) {
      return { clave, estado: "espera" as const, detalle: check?.titulo ?? null };
    }
    // Entregables no tiene checks propios: existe cuando el mes está posteado.
    // Sin esto, un mes cerrado con todo en verde decía «Sin datos del periodo».
    if (clave === "entregables") {
      const posteo = result.checks.find((c) => c.clave === "posteo");
      if (!posteo) return { clave, estado: "sin_datos" as const, detalle: null };
      return posteo.estado === "ok"
        ? { clave, estado: "listo" as const, detalle: "XML del periodo listos" }
        : { clave, estado: "espera" as const, detalle: "Se generan al postear el mes" };
    }
    if (!check) {
      return { clave, estado: "sin_datos" as const, detalle: null };
    }
    if (check.estado === "error") {
      bloqueado = true;
      return { clave, estado: "bloquea" as const, detalle: check.titulo };
    }
    if (check.estado === "warn") {
      return { clave, estado: "atencion" as const, detalle: check.titulo };
    }
    return { clave, estado: "listo" as const, detalle: check.titulo };
  });
}
