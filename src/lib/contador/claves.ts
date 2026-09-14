import type { CompanyPlan } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// LA PASADA DEL CONTADOR: cadencia y forma de la salida. Sin Node.
//
// La salida NO es prosa. Un párrafo bonito no se puede contar, ni ordenar, ni
// convertir en el rail de mañana, ni comparar contra el de ayer para saber si
// el agente está sirviendo de algo. Cada renglón dice CUATRO cosas y las cuatro
// hacen falta:
//
//   estado    qué pasó con esto (lo atendí / sigue pendiente / lo pedí / lo
//             escalé), que es lo que ordena la lista;
//   causa     por qué está así — sin causa, el renglón es un síntoma y el mes
//             que viene vuelve igual;
//   accion    qué se hizo o qué hay que hacer, en imperativo y concreto;
//   evidencia los ids que lo respaldan, para que nadie tenga que creerle al
//             modelo: se abre y se ve.
// ─────────────────────────────────────────────────────────────────────────────

export type CadenciaPasada = "diaria" | "semanal" | "solo_eventos";

/**
 * Cada cuánto se le dedica una pasada de razonamiento a una empresa.
 *
 * No es una restricción comercial arbitraria: una pasada cuesta dinero real por
 * empresa y por día, y el plan es lo que dice cuánto vale la pena gastarle.
 */
export function cadenciaDePlan(plan: CompanyPlan): CadenciaPasada {
  if (plan === "PRO" || plan === "DESPACHO") return "diaria";
  if (plan === "AUTOMATIZADO") return "semanal";
  return "solo_eventos";
}

/**
 * ¿A esta empresa le toca pasada hoy? PURA.
 *
 * Vive aquí y no en el runner a propósito: es una regla, no una consulta, y
 * enterrarla junto a Prisma la haría imposible de probar sin base de datos.
 */
export function tocaHoy(cadencia: CadenciaPasada, hoy: Date): boolean {
  if (cadencia === "diaria") return true;
  // La semanal cae en lunes: el cliente la lee el día que retoma el trabajo, no
  // el viernes cuando ya cerró la semana.
  if (cadencia === "semanal") return hoy.getUTCDay() === 1;
  return false;
}

export type EstadoRenglon = "atendido" | "pendiente" | "solicitado" | "escalado";

export const ESTADOS_RENGLON: readonly EstadoRenglon[] = [
  "escalado",
  "pendiente",
  "solicitado",
  "atendido",
] as const;

export const TITULO_ESTADO_RENGLON: Record<EstadoRenglon, string> = {
  atendido: "Atendido",
  pendiente: "Pendiente",
  solicitado: "Pedido al cliente",
  escalado: "Requiere una decisión",
};

/**
 * Orden de lectura: primero lo que alguien tiene que decidir, al final lo que ya
 * quedó resuelto. Quien abre el resumen tiene tres segundos, y en esos tres
 * segundos debe ver lo que no puede resolverse solo.
 */
export const ORDEN_ESTADO: Record<EstadoRenglon, number> = {
  escalado: 0,
  pendiente: 1,
  solicitado: 2,
  atendido: 3,
};

export interface RenglonResumen {
  estado: EstadoRenglon;
  titulo: string;
  causa: string;
  accion: string;
  evidencia: string[];
  /** Artículo o regla citada, cuando el renglón afirma algo de la norma. */
  fundamento?: string | null;
}

export interface ResumenCorrida {
  renglones: RenglonResumen[];
  /** true cuando la pasada no encontró nada que valga la pena contar. */
  sinNovedad: boolean;
}

export function esEstadoRenglon(v: unknown): v is EstadoRenglon {
  return typeof v === "string" && (ESTADOS_RENGLON as readonly string[]).includes(v);
}

/** Cuántos renglones se guardan. Un resumen de treinta puntos no se lee. */
export const MAX_RENGLONES = 12;

/** Largo máximo de cada campo de texto de un renglón. */
export const MAX_TEXTO = 400;
