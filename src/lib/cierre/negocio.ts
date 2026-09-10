// ─────────────────────────────────────────────────────────────────────────────
// EL MES, CONTADO AL DUEÑO DEL NEGOCIO.
//
// La pantalla del contador responde «qué hago ahora». Ésta responde las tres
// preguntas de quien no lleva la contabilidad: ¿vamos bien?, ¿cuánto voy a
// pagar? y ¿para cuándo?. Nada de jerga, ninguna acción fiscal: quien no cierra
// el mes no debería poder firmarlo.
//
// PURA sobre la misma evaluación que ya calcula el motor: si el número está
// aquí y allá, es el mismo número.
// ─────────────────────────────────────────────────────────────────────────────

import { accionesDelCierre, avanceDelCierre } from "./acciones";
import { estadoDelPeriodo } from "./estado-periodo";
import type { CierreEvaluado } from "./evaluar";

export interface ResumenNegocio {
  /** Nada pendiente en todo el mes. */
  alDia: boolean;
  listos: number;
  total: number;
  /** Lo que falta, en llano y sin repetir: máximo 5. */
  falta: { hacer: string; detiene: boolean }[];
  /** Cuántos pendientes detienen el cierre. */
  detienen: number;
  /** Impuestos del mes cuando el motor ya los calculó. */
  aPagar: { iva: number | null; isr: number | null } | null;
  /** Fecha límite de la declaración y días que quedan. */
  fechaLimite: string | null;
  diasRestantes: number | null;
  /** Ya se presentó la declaración del mes. */
  declarado: boolean;
  /** La declaración llegó como un cierre histórico hecho fuera del producto. */
  cerradoFueraDeContabilidadOS: boolean;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function resumenNegocio(cierre: CierreEvaluado): ResumenNegocio {
  const acciones = accionesDelCierre(cierre);
  const avance = avanceDelCierre(cierre);

  const declaracion = cierre.pasos.find((p) => p.clave === "declaracion");
  const impuestos = cierre.pasos.find((p) => p.clave === "impuestos");
  const cifrasDecl = (declaracion?.cifras ?? {}) as Record<string, unknown>;
  const isr = num(cifrasDecl.isrPagar);
  const iva = num(cifrasDecl.ivaPagar);
  const aPagar = isr == null && iva == null ? null : { iva, isr };

  // Una sola fuente para «ya se declaró»: la misma señal que mira la pantalla
  // del contador. Suponerlo por ausencia de pendientes sería inventarle
  // tranquilidad a alguien.
  const { declarado } = estadoDelPeriodo(cierre);
  const cerradoFueraDeContabilidadOS = cierre.estado.origenCierre === "FUERA_DE_CONTABILIDAD_OS";

  const vistos = new Set<string>();
  const falta: ResumenNegocio["falta"] = [];
  for (const a of acciones) {
    if (vistos.has(a.hacer)) continue;
    vistos.add(a.hacer);
    falta.push({ hacer: a.hacer, detiene: a.urgencia === "bloquea" });
    if (falta.length === 5) break;
  }

  return {
    // Presentar no tapa un bloqueo tardío. Sólo el estado canónico puede decir
    // que el periodo cerró; fuera de eso, estar al día exige cero acciones y
    // evidencia suficiente.
    alDia: cierre.estado.cerrado || (cierre.estado.fase !== "BLOQUEADO" && acciones.length === 0),
    listos: avance.listos,
    total: avance.total,
    falta: cerradoFueraDeContabilidadOS ? [] : falta,
    detienen: cerradoFueraDeContabilidadOS ? 0 : cierre.estado.bloqueos.length,
    aPagar,
    fechaLimite: declaracion?.fechaLimite ?? impuestos?.fechaLimite ?? null,
    diasRestantes: declaracion?.diasRestantes ?? impuestos?.diasRestantes ?? null,
    declarado,
    cerradoFueraDeContabilidadOS,
  };
}
