// ─── Candado de timbrado: decisión pura ──────────────────────────────────────
// El timbrado emite CFDIs REALES ante el SAT: dos llamadas concurrentes sobre
// la misma corrida (doble clic, o timbrado individual traslapado con el lote
// del cockpit) duplicarían los comprobantes. La RECLAMACIÓN del candado es
// atómica en base de datos (UPDATE condicional en stampPayrollRun); este
// módulo contiene únicamente la decisión pura — sin Prisma ni red — para poder
// probarla de forma unitaria y para diagnosticar el motivo de un rechazo.

/**
 * Motivo por el que una corrida NO puede reclamarse para timbrar, o null si
 * sí puede: debe estar en estado CALCULATED y sin un timbrado en curso
 * (extraData.stampingInProgress). La clave ausente o en false cuenta como
 * "sin timbrado en curso" (corridas nunca timbradas no traen la clave).
 */
export function motivoTimbradoNoDisponible(run: {
  status: string;
  extraData: unknown;
}): string | null {
  if (run.status !== "CALCULATED") {
    return `Estado inválido: ${run.status}. Debe estar CALCULATED.`;
  }
  const extra = (run.extraData ?? {}) as Record<string, unknown>;
  if (extra.stampingInProgress === true) {
    return "Timbrado en curso: otra operación ya está emitiendo los CFDIs de esta corrida. Espere a que termine antes de reintentar — timbrar dos veces duplicaría los CFDIs ante el SAT.";
  }
  return null;
}
