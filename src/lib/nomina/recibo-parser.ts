// ─────────────────────────────────────────────────────────────────────────────
// Parser PURO de un recibo de nómina timbrado — sin Prisma, sin BD.
//
// Vivía dentro de historia-import.ts, que importa prisma para el import
// histórico. La pantalla de Facturas (cliente) empezó a leer el tipo de
// corrida y arrastró el cliente de Prisma al bundle del navegador: «PrismaClient
// is unable to run in this browser environment» y la pantalla en blanco
// (14-sep-2026). Lo que puede correr en el navegador vive aquí; lo que toca
// la base sigue en historia-import.ts y re-exporta esto.
// ─────────────────────────────────────────────────────────────────────────────

import { parseComplementoNomina, type ComplementoNomina } from "./roster-import";

export interface DesgloseNomina {
  // Percepciones (gravado + exento por TipoPercepcion)
  sueldoBase: number; // 001 Sueldos (incluye vacaciones pagadas como 001)
  horasExtra: number; // 019 Horas extra
  vales: number; // 029 Vales de despensa
  aguinaldo: number; // 002 Aguinaldo
  primaVacacional: number; // 021 Prima vacacional
  ptu: number; // 003 PTU
  otrasPercepciones: number; // resto de percepciones
  // Deducciones
  isrRetenido: number; // 002 ISR
  imssObrero: number; // 001 Seguridad social (cuota obrera)
  infonavit: number; // 009/010 crédito de vivienda
  otrasDeducc: number; // resto de deducciones
  // Otros pagos (no son percepción ni deducción; suman al neto)
  subsidioEmpleo: number; // TipoOtroPago 002 Subsidio para el empleo
  otrosPagos: number; // resto de otros pagos
  totalPercepciones: number;
  totalDeducciones: number;
  totalOtrosPagos: number;
  /** Neto = percepciones + otros pagos − deducciones. */
  netoAPagar: number;
}

export interface ReciboNominaHistorico {
  /** Datos del trabajador (parser del roster, reutilizado tal cual). */
  complemento: ComplementoNomina;
  /** RFC del EMISOR del CFDI — para confirmar que el recibo es de la empresa. */
  rfcEmisor: string | null;
  /** FechaInicialPago / FechaFinalPago del nodo Nomina (ISO date). */
  fechaInicialPago: string | null;
  fechaFinalPago: string | null;
  numDiasPagados: number | null;
  desglose: DesgloseNomina;
}

// Percepciones → columna de PayrollItem (mismos códigos que usa calc-nomina).
const PERCEPCION_COL: Record<string, keyof DesgloseNomina> = {
  "001": "sueldoBase",
  "019": "horasExtra",
  "029": "vales",
  "002": "aguinaldo",
  "021": "primaVacacional",
  "003": "ptu",
};

// Deducciones → columna (001 IMSS, 002 ISR, 009/010 vivienda; ver calc-nomina).
const DEDUCCION_COL: Record<string, keyof DesgloseNomina> = {
  "001": "imssObrero",
  "002": "isrRetenido",
  "009": "infonavit",
  "010": "infonavit",
};

function num(v: string | null | undefined): number {
  const n = v != null && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Parsea un CFDI de nómina timbrado y devuelve lo necesario para reconstruir
 * el PayrollItem histórico. Devuelve null si el XML no es un recibo de nómina
 * legible (mismos criterios que parseComplementoNomina). NO lanza.
 */
export function parseReciboNominaHistorico(
  rawXml: string | null | undefined
): ReciboNominaHistorico | null {
  const complemento = parseComplementoNomina(rawXml);
  if (!complemento || !rawXml) return null;

  const nominaAttrs = /<(?:[a-zA-Z0-9]+:)?Nomina\b([^>]*)>/.exec(rawXml)?.[1] ?? "";
  const nAttr = (name: string) =>
    new RegExp(`\\b${name}="([^"]*)"`).exec(nominaAttrs)?.[1] ?? null;

  const rfcEmisor =
    /<(?:[a-zA-Z0-9]+:)?Emisor\b[^>]*\bRfc="([^"]*)"/.exec(rawXml)?.[1]?.toUpperCase() ?? null;

  const desglose: DesgloseNomina = {
    sueldoBase: 0,
    horasExtra: 0,
    vales: 0,
    aguinaldo: 0,
    primaVacacional: 0,
    ptu: 0,
    otrasPercepciones: 0,
    isrRetenido: 0,
    imssObrero: 0,
    infonavit: 0,
    otrasDeducc: 0,
    subsidioEmpleo: 0,
    otrosPagos: 0,
    totalPercepciones: 0,
    totalDeducciones: 0,
    totalOtrosPagos: 0,
    netoAPagar: 0,
  };

  // Percepciones: importe = gravado + exento. El tag puede ser autocontenido o
  // envolver hijos (HorasExtra, SeparacionIndemnizacion) — sólo leemos attrs.
  const percRe = /<(?:[a-zA-Z0-9]+:)?Percepcion\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = percRe.exec(rawXml)) !== null) {
    const attrs = m[1];
    const get = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const tipo = get("TipoPercepcion");
    if (!tipo) continue;
    const importe = num(get("ImporteGravado")) + num(get("ImporteExento"));
    const col = PERCEPCION_COL[tipo] ?? "otrasPercepciones";
    desglose[col] = round2(desglose[col] + importe);
    desglose.totalPercepciones = round2(desglose.totalPercepciones + importe);
  }

  // Deducciones.
  const dedRe = /<(?:[a-zA-Z0-9]+:)?Deduccion\b([^>]*?)\/?>/g;
  while ((m = dedRe.exec(rawXml)) !== null) {
    const attrs = m[1];
    const get = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const tipo = get("TipoDeduccion");
    if (!tipo) continue;
    const importe = num(get("Importe"));
    const col = DEDUCCION_COL[tipo] ?? "otrasDeducc";
    desglose[col] = round2(desglose[col] + importe);
    desglose.totalDeducciones = round2(desglose.totalDeducciones + importe);
  }

  // Otros pagos (subsidio al empleo 002, viáticos 003, etc.). Suman al neto.
  const otroRe = /<(?:[a-zA-Z0-9]+:)?OtroPago\b([^>]*?)\/?>/g;
  while ((m = otroRe.exec(rawXml)) !== null) {
    const attrs = m[1];
    const get = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
    const importe = num(get("Importe"));
    if (get("TipoOtroPago") === "002") desglose.subsidioEmpleo = round2(desglose.subsidioEmpleo + importe);
    else desglose.otrosPagos = round2(desglose.otrosPagos + importe);
    desglose.totalOtrosPagos = round2(desglose.totalOtrosPagos + importe);
  }

  // Los totales del nodo Nomina mandan si vienen (son los timbrados); el
  // desglose sumado es el fallback para XML sin totales.
  const totPerc = nAttr("TotalPercepciones");
  const totDed = nAttr("TotalDeducciones");
  const totOtros = nAttr("TotalOtrosPagos");
  if (totPerc != null && totPerc !== "") desglose.totalPercepciones = num(totPerc);
  if (totDed != null && totDed !== "") desglose.totalDeducciones = num(totDed);
  if (totOtros != null && totOtros !== "") desglose.totalOtrosPagos = num(totOtros);
  desglose.netoAPagar = round2(
    desglose.totalPercepciones + desglose.totalOtrosPagos - desglose.totalDeducciones
  );

  return {
    complemento,
    rfcEmisor,
    fechaInicialPago: nAttr("FechaInicialPago"),
    fechaFinalPago: nAttr("FechaFinalPago"),
    numDiasPagados: nAttr("NumDiasPagados") != null ? num(nAttr("NumDiasPagados")) : null,
    desglose,
  };
}

// ── 2. Agrupación PURA en corridas + regla de dedup ──────────────────────────

export type TipoCorrida =
  | "ORDINARIA"
  | "EXTRAORDINARIA"
  | "FINIQUITO"
  | "AGUINALDO"
  | "PTU";

/** Deriva el tipo de corrida de un recibo (finiquito > aguinaldo/PTU > O/E). */
export function derivarTipoCorrida(r: ReciboNominaHistorico): TipoCorrida {
  if (r.complemento.esFiniquito) return "FINIQUITO";
  if (r.complemento.tipoNomina === "E") {
    // Extraordinaria dominada por una sola prestación → tipo específico.
    if (r.desglose.aguinaldo > 0 && r.desglose.aguinaldo >= r.desglose.ptu) return "AGUINALDO";
    if (r.desglose.ptu > 0) return "PTU";
    return "EXTRAORDINARIA";
  }
  return "ORDINARIA";
}
