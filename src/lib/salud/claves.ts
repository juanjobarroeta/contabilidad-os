// ─────────────────────────────────────────────────────────────────────────────
// LAS CLAVES DE LA SALUD DE UNA EMPRESA.
//
// Módulo sin dependencias de Node a propósito (mismo criterio que
// lib/cierre/claves.ts): lo importan el evaluador del servidor y los
// componentes del cliente, y una importación de `node:crypto` aquí rompería el
// bundle del navegador.
//
// Las claves son ESTABLES: entran en el `deltaKey` que dedupe los avisos y se
// guardan dentro del JSON de cada snapshot. Renombrar una clave es perder la
// continuidad contra los snapshots ya escritos, así que no se renombran: se
// agregan nuevas y la vieja deja de emitirse.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estado de una dimensión.
 *
 *   ok         va al corriente, no hay nada que hacer
 *   atencion   hay algo que arreglar, pero no impide entregar
 *   bloquea    impide entregar la contabilidad o expone al cliente
 *   sin_datos  no se puede saber (falta la credencial, nunca se ha corrido)
 *
 * `sin_datos` NO es `ok`: no saber es un estado, y esconderlo detrás de un
 * verde es cómo una empresa se queda meses sin que nadie note que no hay datos.
 */
export type EstadoSalud = "ok" | "atencion" | "bloquea" | "sin_datos";

/**
 * Orden total de gravedad: MENOR es peor.
 *
 * Es lo que decide si un cambio «empeoró» y cuál es el estado global de la
 * empresa (el peor de sus dimensiones). `sin_datos` va al final porque no es
 * una buena noticia pero tampoco un problema demostrado.
 */
export const PESO_ESTADO: Record<EstadoSalud, number> = {
  bloquea: 0,
  atencion: 1,
  ok: 2,
  sin_datos: 3,
};

export const CLAVES_SALUD = [
  "datos_sat",
  "credenciales",
  "cumplimiento",
  "declaraciones",
  "contabilidad_electronica",
  "bancos",
  "iva_flujo",
  "hallazgos",
  "solicitudes",
] as const;

export type ClaveSalud = (typeof CLAVES_SALUD)[number];

/** El título que ve una persona. El orden del objeto es el orden de lectura. */
export const TITULO_SALUD: Record<ClaveSalud, string> = {
  datos_sat: "Datos del SAT",
  credenciales: "Credenciales",
  cumplimiento: "Opinión de cumplimiento",
  declaraciones: "Declaraciones",
  contabilidad_electronica: "Contabilidad electrónica",
  bancos: "Bancos",
  iva_flujo: "IVA en flujo",
  hallazgos: "Hallazgos del auditor",
  solicitudes: "Pendientes del cliente",
};

/**
 * Orden de atención: primero lo que impide ENTREGAR, luego lo que EXPONE al
 * cliente, al final la limpieza. Empata con los tres objetivos del contador.
 */
export const ORDEN_SALUD: ClaveSalud[] = [
  "declaraciones",
  "datos_sat",
  "credenciales",
  "contabilidad_electronica",
  "cumplimiento",
  "iva_flujo",
  "bancos",
  // Lo que se le pidió al cliente va al final de la lista de atención pero NO
  // es lo menos importante: es lo único que el despacho no puede resolver solo,
  // y una solicitud vieja suele ser la causa de algo que sí está arriba.
  "solicitudes",
  "hallazgos",
];

/**
 * Qué le pasó a una dimensión contra el snapshot anterior.
 *
 * No hay `vencio` / `por_vencer` como en el cierre porque aquí las cuentas
 * regresivas (vigencia de la e.firma, antigüedad de la última sincronización)
 * ya están expresadas como ESTADO: cruzar el umbral cambia el estado y eso
 * emite un `empeoro` una sola vez. Un umbral que además se avisara aparte
 * avisaría dos veces por el mismo hecho.
 */
export type DireccionDelta = "nuevo" | "empeoro" | "mejoro";
