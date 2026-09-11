// ─────────────────────────────────────────────────────────────────────────────
// La DIMENSIÓN de cada código del motor (docs/PLAN-motor-plan-propio.md → 2i).
//
// La cobertura del plan propio clasificaba por «¿cuántas candidatas hay?»:
// una → resuelve, varias → ambigua → que decida el contador. Eso trata toda
// ambigüedad como si fuera la misma, y no lo es.
//
// Un plan de PyME mexicana lleva UN AUXILIAR POR CONTRAPARTE: 2110-001 Telmex,
// 2110-002 CFE, 2110-003 Wal-Mart… Preguntar «¿cuál de tus 31 proveedores es
// *la* cuenta de proveedores?» no tiene respuesta correcta, y cualquiera que se
// elija manda el saldo de los 31 a la que se haya clicado. Medido en BAOBAB:
// de 8 «decisiones», SEIS eran de esta clase y sólo dos eran preguntas reales.
//
// Entonces la pregunta previa no es cuántas candidatas hay, sino QUÉ elige la
// cuenta:
//
//   FIJA        una sola cuenta para todo el código. Si hay varias candidatas
//               es una decisión genuina y sí es del contador — «¿esta venta es
//               401.01 ventas o 401.01 arrendamiento?».
//   CONTRAPARTE la elige con quién se hizo la operación. No se decide una vez:
//               se resuelve en cada asiento, por el RFC del comprobante.
//   EJERCICIO   la elige el año. «Utilidad de ejercicios anteriores» tiene una
//               subcuenta por ejercicio y ninguna es «la» correcta.
//
// ESTE ARCHIVO NO POSTEA NADA. Sólo dice de qué tipo es cada código, para que
// la cola deje de preguntar lo que no se puede contestar. Resolver de verdad
// por contraparte es el paso siguiente del plan y necesita el enlace
// Customer → cuenta; mientras tanto estos códigos caen al fallback de siempre,
// exactamente como hoy — pero sin exigirle a nadie una respuesta inventada.
// ─────────────────────────────────────────────────────────────────────────────

import { COE_CODES } from "./catalog";

export type Dimension = "FIJA" | "CONTRAPARTE" | "EJERCICIO";

/** De qué padrón sale la contraparte que elige la cuenta. */
export type Padron = "BANCO" | "CLIENTE" | "PROVEEDOR" | "RELACIONADA";

export interface DimensionCodigo {
  dimension: Dimension;
  padron?: Padron;
  /** En una línea, y en voz de quien cierra: la cola lo enseña tal cual. */
  porque: string;
}

const CONTRAPARTE = (padron: Padron, porque: string): DimensionCodigo => ({ dimension: "CONTRAPARTE", padron, porque });

/**
 * Sólo los códigos que NO son FIJA. Lo demás es fijo por default: es la
 * mayoría (32 de 42) y enumerarlo sería ruido que envejece mal.
 */
export const DIMENSION_POR_CODIGO: Readonly<Record<string, DimensionCodigo>> = {
  [COE_CODES.BANCOS]: CONTRAPARTE("BANCO", "Cada cuenta bancaria tiene la suya; la elige el banco del movimiento."),
  [COE_CODES.CLIENTES_NACIONALES]: CONTRAPARTE("CLIENTE", "Un auxiliar por cliente; lo elige el RFC del receptor."),
  [COE_CODES.ANTICIPOS_CLIENTES]: CONTRAPARTE("CLIENTE", "El anticipo es de un cliente concreto."),
  [COE_CODES.PROVEEDORES]: CONTRAPARTE("PROVEEDOR", "Un auxiliar por proveedor; lo elige el RFC del emisor."),
  [COE_CODES.ANTICIPOS_PROVEEDORES]: CONTRAPARTE("PROVEEDOR", "El anticipo es a un proveedor concreto."),
  [COE_CODES.DEUDORES_DIVERSOS]: CONTRAPARTE("CLIENTE", "Un auxiliar por deudor."),
  [COE_CODES.ACREEDORES_DIVERSOS]: CONTRAPARTE("PROVEEDOR", "Un auxiliar por acreedor."),
  [COE_CODES.PRESTAMOS_OTORGADOS]: CONTRAPARTE("RELACIONADA", "Un auxiliar por parte relacionada."),
  [COE_CODES.PRESTAMOS_RECIBIDOS]: CONTRAPARTE("RELACIONADA", "Un auxiliar por parte relacionada."),
  [COE_CODES.RESULTADOS_ACUMULADOS]: {
    dimension: "EJERCICIO",
    porque: "Una subcuenta por ejercicio (2021, 2022, 2024…); la elige el año, no una preferencia.",
  },
};

export const DIMENSION_FIJA: DimensionCodigo = {
  dimension: "FIJA",
  porque: "Una sola cuenta para todo el código.",
};

export function dimensionDe(codigoMotor: string): DimensionCodigo {
  return DIMENSION_POR_CODIGO[codigoMotor] ?? DIMENSION_FIJA;
}

/**
 * ¿Varias candidatas aquí son una decisión de persona, o la forma normal del
 * catálogo? Es la pregunta que la cola tenía que haber hecho desde el principio.
 */
export function esDecisionDePersona(codigoMotor: string): boolean {
  return dimensionDe(codigoMotor).dimension === "FIJA";
}
