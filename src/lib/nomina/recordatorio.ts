// ─────────────────────────────────────────────────────────────────────────────
// Recordatorio proactivo de nómina (T-1) — lógica PURA, sin prisma/IO.
//
// El contador "te recuerda" el día ANTES de que toque timbrar la nómina:
//   SEMANAL   → paga el viernes → recuerda el JUEVES.
//   QUINCENAL → paga el 15 y el último día del mes → recuerda el 14 y la
//               víspera del fin de mes.
//   MENSUAL   → paga el último día del mes → recuerda la víspera.
//
// El timbrado en sí sigue siendo una acción HUMANA de un toque (irreversible):
// esto SÓLO recuerda y abre el flujo. No dispara nada automático.
//
// "Mañana" se entiende como el siguiente día NATURAL (calendario), no hábil:
// el aviso llega un día antes del día de pago nominal aunque caiga en fin de
// semana, porque el contador adelanta el timbrado al hábil previo.
// ─────────────────────────────────────────────────────────────────────────────

export type CadenciaNomina = "SEMANAL" | "QUINCENAL" | "MENSUAL";

/** Etiqueta humana en español para el cuerpo del push. */
export const CADENCIA_LABEL: Record<CadenciaNomina, string> = {
  SEMANAL: "semanal",
  QUINCENAL: "quincenal",
  MENSUAL: "mensual",
};

export type RecordatorioNomina = {
  vence: boolean;
  /** Día de pago nominal (mañana respecto a `hoy`) cuando `vence` es true. */
  fechaPago?: Date;
  /** Motivo legible (p.ej. "viernes", "día 15", "fin de mes"). */
  motivo?: string;
};

/** Mismo día calendario (ignora hora). */
function mismaFecha(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Día siguiente (calendario) a las 00:00 locales. */
function manana(hoy: Date): Date {
  const m = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  m.setDate(m.getDate() + 1);
  return m;
}

/** Último día del mes de `d`. */
function ultimoDiaDelMes(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/**
 * ¿La nómina de esta cadencia vence MAÑANA (respecto a `hoy`)?
 *
 * Pura y determinista: depende sólo de la cadencia y de la fecha. `hoy` se
 * interpreta en su hora local; sólo importa el día.
 */
export function nominaVenceManana(cadencia: CadenciaNomina, hoy: Date): RecordatorioNomina {
  const dia = manana(hoy); // el día de pago candidato
  const dow = dia.getDay(); // 0=Dom … 6=Sáb
  const dom = dia.getDate(); // día del mes del candidato
  const ultimo = ultimoDiaDelMes(dia);

  switch (cadencia) {
    case "SEMANAL": {
      // Paga el viernes (dow 5) → recordatorio el jueves.
      if (dow === 5) return { vence: true, fechaPago: dia, motivo: "viernes" };
      return { vence: false };
    }
    case "QUINCENAL": {
      // Paga el 15 y el último día del mes.
      if (dom === 15) return { vence: true, fechaPago: dia, motivo: "día 15" };
      if (dom === ultimo) return { vence: true, fechaPago: dia, motivo: "fin de mes" };
      return { vence: false };
    }
    case "MENSUAL": {
      // Paga el último día del mes.
      if (dom === ultimo) return { vence: true, fechaPago: dia, motivo: "fin de mes" };
      return { vence: false };
    }
    default: {
      // Exhaustividad: si llega una cadencia desconocida, no recordamos.
      const _exhaustive: never = cadencia;
      void _exhaustive;
      return { vence: false };
    }
  }
}

// ── Inferencia de cadencia ────────────────────────────────────────────────────
// La cadencia "oficial" vive en Company.periodicidadNomina, pero para empresas
// existentes (default QUINCENAL) inferimos una mejor desde los datos de campo.

/**
 * Mapea el código SAT de periodicidad de pago (Employee.periodicidadPago) a
 * nuestra cadencia. Códigos c_PeriodicidadPago: 01=Diario, 02=Semanal,
 * 03=Catorcenal, 04=Quincenal, 05=Mensual, 06=Bimestral, 99=Otra.
 * Catorcenal/semanal se tratan como SEMANAL (recordatorio cada jueves).
 */
export function cadenciaDesdeCodigoSat(codigo: string | null | undefined): CadenciaNomina | null {
  switch ((codigo ?? "").trim()) {
    case "01": // diario → lo tratamos como semanal para el recordatorio
    case "02": // semanal
    case "03": // catorcenal
      return "SEMANAL";
    case "04": // quincenal
      return "QUINCENAL";
    case "05": // mensual
    case "06": // bimestral → recordamos fin de mes
      return "MENSUAL";
    default:
      return null;
  }
}

/**
 * Infiere la cadencia predominante de un conjunto de códigos SAT de empleados
 * (la moda). Devuelve null si no hay señal utilizable.
 */
export function inferirCadenciaDesdeEmpleados(
  periodicidadesPago: Array<string | null | undefined>
): CadenciaNomina | null {
  const conteo = new Map<CadenciaNomina, number>();
  for (const cod of periodicidadesPago) {
    const c = cadenciaDesdeCodigoSat(cod);
    if (c) conteo.set(c, (conteo.get(c) ?? 0) + 1);
  }
  let mejor: CadenciaNomina | null = null;
  let max = 0;
  for (const [c, n] of conteo) {
    if (n > max) {
      max = n;
      mejor = c;
    }
  }
  return mejor;
}

/**
 * Infiere la cadencia desde la duración (en días) de los periodos de corridas
 * ORDINARIAS pasadas. ≤8 días → SEMANAL; ≤20 → QUINCENAL; resto → MENSUAL.
 * Devuelve la moda, o null si no hay corridas utilizables.
 */
export function inferirCadenciaDesdeRuns(
  duracionesDias: number[]
): CadenciaNomina | null {
  const conteo = new Map<CadenciaNomina, number>();
  for (const d of duracionesDias) {
    if (!Number.isFinite(d) || d <= 0) continue;
    const c: CadenciaNomina = d <= 8 ? "SEMANAL" : d <= 20 ? "QUINCENAL" : "MENSUAL";
    conteo.set(c, (conteo.get(c) ?? 0) + 1);
  }
  let mejor: CadenciaNomina | null = null;
  let max = 0;
  for (const [c, n] of conteo) {
    if (n > max) {
      max = n;
      mejor = c;
    }
  }
  return mejor;
}
