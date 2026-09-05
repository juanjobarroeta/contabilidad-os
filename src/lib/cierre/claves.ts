// Claves del workflow del cierre — módulo SIN dependencias de Node, para que
// los componentes de cliente puedan validar `?paso=` sin arrastrar el hash
// (node:crypto) de workflow.ts al bundle del navegador.

export type ClavePasoCierre =
  | "apertura"
  | "sat"
  | "nomina"
  | "imss"
  | "banco"
  | "complementos"
  | "impuestos"
  | "diot"
  | "contabilidad"
  | "revision"
  | "declaracion"
  | "entregables";

export const ORDEN_PASOS: ClavePasoCierre[] = [
  "apertura",
  "sat",
  "nomina",
  "imss",
  "banco",
  "complementos",
  "impuestos",
  "diot",
  "contabilidad",
  "revision",
  "declaracion",
  "entregables",
];

export function esClavePaso(v: unknown): v is ClavePasoCierre {
  return typeof v === "string" && (ORDEN_PASOS as string[]).includes(v);
}
