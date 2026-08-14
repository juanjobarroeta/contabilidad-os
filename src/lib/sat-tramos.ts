// ─────────────────────────────────────────────────────────────────────────────
// Partir un mes en tramos de fechas para esquivar la cuota 5002 del SAT.
//
// El SAT cuenta las solicitudes DE POR VIDA por (RFC + rango + tipo). Medido en
// producción con MARGOM 2025-04: el mes completo devuelve 5002 en emitidos Y en
// recibidos, y esperar no lo libera. El propio mensaje del SAT dice la salida:
// «pide un rango de fechas distinto».
//
// Un tramo es un rango DISTINTO, así que es otra llave de cuota. El costo es
// más solicitudes: 2 tramos = 4 solicitudes (emitidos + recibidos por tramo).
//
// Reglas que estas funciones sí garantizan:
//   · cobertura exacta — la unión de los tramos es el mes entero, sin huecos
//   · sin traslape — ningún segundo pertenece a dos tramos (si un CFDI cayera
//     en dos, entraría dos veces; el import dedup por UUID, pero no queremos
//     depender de eso)
//   · los límites son [00:00:00 del primer día, 23:59:59 del último]
// ─────────────────────────────────────────────────────────────────────────────

export interface Tramo {
  /** Inicio inclusivo, 00:00:00 hora local (así lo espera el SAT). */
  desde: Date;
  /** Fin inclusivo, 23:59:59 — el SAT rechaza rangos que llegan a hoy. */
  hasta: Date;
}

export const MAX_TRAMOS = 31;

/**
 * Parte el mes en `tramos` pedazos contiguos de días completos.
 *
 * Reparte los días sobrantes entre los primeros tramos en vez de dejarlos todos
 * al final: con 31 días en 2 tramos da 16 + 15, no 15 + 16 y un día huérfano.
 * Si se piden más tramos que días, devuelve un tramo por día — no tramos vacíos.
 */
export function partirMes(year: number, month: number, tramos = 1): Tramo[] {
  const dias = new Date(year, month, 0).getDate();
  // Un `tramos` no finito (NaN de un parseo fallido) colapsaba el bucle a CERO
  // tramos: no se pedía nada y el mes se quedaba igual de vacío, en silencio.
  const pedidos = Number.isFinite(tramos) ? Math.trunc(tramos) : 1;
  const n = Math.max(1, Math.min(pedidos, dias, MAX_TRAMOS));

  const base = Math.floor(dias / n);
  const sobran = dias % n;

  const out: Tramo[] = [];
  let dia = 1;
  for (let i = 0; i < n; i++) {
    const largo = base + (i < sobran ? 1 : 0);
    const ultimo = dia + largo - 1;
    out.push({
      desde: new Date(year, month - 1, dia, 0, 0, 0),
      hasta: new Date(year, month - 1, ultimo, 23, 59, 59),
    });
    dia = ultimo + 1;
  }
  return out;
}

/** "2025-04-01T00:00:00" — el formato que espera DateTime del SDK del SAT. */
export function isoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    [d.getFullYear(), p(d.getMonth() + 1), p(d.getDate())].join("-") +
    "T" +
    [p(d.getHours()), p(d.getMinutes()), p(d.getSeconds())].join(":")
  );
}

/** Etiqueta corta para reportes: "04-01→04-15". */
export function etiquetaTramo(t: Tramo): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(t.desde.getMonth() + 1)}-${p(t.desde.getDate())}→${p(t.hasta.getMonth() + 1)}-${p(t.hasta.getDate())}`;
}
