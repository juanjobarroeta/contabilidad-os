// ─────────────────────────────────────────────────────────────────────────────
// Fecha de EMISIÓN del CFDI de nómina elegida por el usuario ("fechar el
// timbrado"). El SAT sólo acepta una Fecha hasta 72 horas anterior al momento
// del timbrado (Anexo 20 / validación del PAC) — no existe forma legal de
// timbrar en agosto un CFDI fechado en julio. Lo que SÍ determina el mes
// fiscal de la nómina (deducción del patrón, declaraciones) es la FechaPago
// del complemento, que ya viaja aparte y puede ser de cualquier mes pasado.
//
// Este helper convierte la fecha AAAA-MM-DD elegida en el instante más TARDÍO
// posible de ese día (23:59 hora del centro de México) para maximizar la
// probabilidad de caer dentro de la ventana de 72 h, con un margen de 30 min
// para desfases de reloj del PAC. CDMX es UTC-6 fijo desde que se abolió el
// horario de verano (2022), por eso el offset va literal.
// ─────────────────────────────────────────────────────────────────────────────

const FORMATO = /^\d{4}-\d{2}-\d{2}$/;
const VENTANA_SAT_MS = 72 * 60 * 60 * 1000;
const MARGEN_MS = 30 * 60 * 1000;

export type FechaCfdiResuelta = {
  /** Instante a mandar como `date` a Facturapi. Ausente = timbrar con "ahora". */
  fechaCfdi?: Date;
  error?: string;
};

export function resolverFechaCfdi(fecha: string, ahora: Date = new Date()): FechaCfdiResuelta {
  if (!FORMATO.test(fecha)) return { error: "Fecha del CFDI inválida (formato AAAA-MM-DD)" };
  const inicioDia = new Date(`${fecha}T00:00:00-06:00`);
  const finDia = new Date(`${fecha}T23:59:00-06:00`);
  if (isNaN(inicioDia.getTime())) return { error: "Fecha del CFDI inválida" };

  if (inicioDia.getTime() > ahora.getTime()) {
    return { error: "La fecha del CFDI no puede ser futura" };
  }
  // El día elegido aún no termina (es "hoy" en CDMX): dejar que Facturapi
  // feche con el momento exacto del timbrado, como siempre.
  if (finDia.getTime() >= ahora.getTime()) return {};

  if (ahora.getTime() - finDia.getTime() > VENTANA_SAT_MS - MARGEN_MS) {
    return {
      error:
        "El SAT sólo permite fechar un CFDI hasta 72 horas antes del timbrado. " +
        "Para nóminas de periodos anteriores no hace falta antedatar: la FechaPago del " +
        "complemento (la fecha de pago de la corrida) es la que determina el mes fiscal.",
    };
  }
  return { fechaCfdi: finDia };
}
