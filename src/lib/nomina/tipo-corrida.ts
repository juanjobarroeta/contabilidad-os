// ─────────────────────────────────────────────────────────────────────────────
// Qué corrida ES un recibo de nómina, y cómo se nombra en pantalla.
//
// El SAT sólo distingue TipoNomina O/E: un finiquito viaja como "O" y un
// aguinaldo como "E", así que por ese campo un finiquito de $18,000 parece
// una quincena. La señal real está en el complemento —percepciones de
// separación (022/023/025), el nodo SeparacionIndemnizacion, aguinaldo (002),
// PTU (003)— y derivarTipoCorrida ya la lee. Aquí se expone como UNA función
// sobre el rawXml, para el import, el backfill y el export, y UNA etiqueta
// para todas las pantallas.
// ─────────────────────────────────────────────────────────────────────────────

import { derivarTipoCorrida, parseReciboNominaHistorico, type TipoCorrida } from "./historia-import";

export type { TipoCorrida };

/** Tipo de corrida del recibo, o null si el XML no es un recibo de nómina legible. */
export function tipoCorridaDeXml(rawXml: string | null | undefined): TipoCorrida | null {
  const rec = parseReciboNominaHistorico(rawXml);
  return rec ? derivarTipoCorrida(rec) : null;
}

/** Etiqueta corta para chips y badges. Una ORDINARIA se llama «Nómina» a secas. */
export const ETIQUETA_CORRIDA: Record<TipoCorrida, string> = {
  ORDINARIA: "Nómina",
  EXTRAORDINARIA: "Extraordinaria",
  FINIQUITO: "Finiquito",
  AGUINALDO: "Aguinaldo",
  PTU: "PTU",
};

/** Sólo las corridas que NO son la quincena normal merecen un badge propio. */
export function esCorridaEspecial(t: string | null | undefined): t is Exclude<TipoCorrida, "ORDINARIA"> {
  return !!t && t !== "ORDINARIA" && t in ETIQUETA_CORRIDA;
}
