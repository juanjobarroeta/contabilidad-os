// ─────────────────────────────────────────────────────────────────────────────
// LAS CLAVES DEL EXPEDIENTE. Sin Node: lo importa la página, no sólo el servidor.
//
// Un hecho se identifica por una clave ESTABLE. Que el catálogo viva aquí y no
// disperso en cada motor es lo que permite que la terminal que detecta el
// conciliador y la terminal que registra el contador sean el MISMO hecho, y no
// dos renglones que nadie cruza.
//
// El catálogo no es cerrado: un motor puede escribir una clave nueva y el
// expediente la enseña con la clave cruda. Lo que da el catálogo es el título
// en español y el orden en que se leen.
// ─────────────────────────────────────────────────────────────────────────────

export type FuenteExpediente = "motor" | "agente" | "usuario";
export type Confianza = "alta" | "media" | "baja";
export type TipoNota = "observacion" | "decision" | "pendiente" | "resumen_corrida";
export type TemaExpediente =
  | "conciliacion"
  | "sat"
  | "cumplimiento"
  | "declaraciones"
  | "ce"
  | "nomina"
  | "general";

export const TEMAS: readonly TemaExpediente[] = [
  "conciliacion",
  "sat",
  "cumplimiento",
  "declaraciones",
  "ce",
  "nomina",
  "general",
] as const;

export const TIPOS_NOTA: readonly TipoNota[] = [
  "pendiente",
  "decision",
  "observacion",
  "resumen_corrida",
] as const;

export const TITULO_TEMA: Record<TemaExpediente, string> = {
  conciliacion: "Conciliación",
  sat: "Datos del SAT",
  cumplimiento: "Cumplimiento",
  declaraciones: "Declaraciones",
  ce: "Contabilidad electrónica",
  nomina: "Nómina",
  general: "General",
};

export const TITULO_TIPO: Record<TipoNota, string> = {
  observacion: "Observación",
  decision: "Decisión",
  pendiente: "Pendiente",
  resumen_corrida: "Resumen de la corrida",
};

/**
 * Las claves que los motores y la UI ya conocen, con su título.
 *
 * El caso que motivó la tabla está aquí: `terminal.afiliacion`. En agosto no se
 * pudo auditar un centro de procedimientos porque nadie sabía qué terminales
 * tenía la empresa ni con qué afiliación, y el estado de cuenta de la terminal
 * nunca se había pedido. Con el hecho escrito, la app sabe qué pedir.
 */
export const TITULO_CLAVE: Record<string, string> = {
  "terminal.afiliacion": "Afiliación de terminal",
  "terminal.adquirente": "Adquirente de la terminal",
  "banco.cuenta": "Cuenta bancaria",
  "cliente.plazo_pago": "Plazo de pago del cliente",
  "proveedor.moneda": "Moneda con la que factura el proveedor",
  "cierre.responsable": "Responsable del cierre",
  "contacto.principal": "Contacto principal",
  "operacion.giro": "Giro de la operación",
  "operacion.sucursales": "Sucursales",
};

/** El título de una clave, o la clave misma si no está catalogada. */
export function tituloDeClave(clave: string): string {
  return TITULO_CLAVE[clave] ?? clave;
}

/**
 * La familia de una clave: el prefijo antes del primer punto.
 *
 * Es lo que agrupa «terminal.afiliacion» y «terminal.adquirente» en una sola
 * sección de la página sin mantener un segundo catálogo.
 */
export function familiaDeClave(clave: string): string {
  const i = clave.indexOf(".");
  return i > 0 ? clave.slice(0, i) : clave;
}

export const PESO_CONFIANZA: Record<Confianza, number> = { alta: 0, media: 1, baja: 2 };

export function esTema(v: unknown): v is TemaExpediente {
  return typeof v === "string" && (TEMAS as readonly string[]).includes(v);
}

export function esTipoNota(v: unknown): v is TipoNota {
  return typeof v === "string" && (TIPOS_NOTA as readonly string[]).includes(v);
}

export function esConfianza(v: unknown): v is Confianza {
  return v === "alta" || v === "media" || v === "baja";
}

export function esFuente(v: unknown): v is FuenteExpediente {
  return v === "motor" || v === "agente" || v === "usuario";
}
