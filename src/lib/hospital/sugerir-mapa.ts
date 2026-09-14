// ─────────────────────────────────────────────────────────────────────────────
// QUÉ CUENTA PROPIA LE TOCA A CADA CLAVE, SIN PREGUNTÁRSELO A NADIE.
//
// El plan de un hospital no parte por «ingresos» sino por SERVICIO. Visto en
// CENTRO DE PROCEDIMIENTOS: 28 cuentas con el agrupador 401.01 (Quirofanos,
// Urgencias, Laboratorio, Farmacia 16 %…), 33 con 501.01 y 29 con 115.01, una
// por almacén. La cola de mapeo del hub, que sólo sabe contar candidatas,
// pregunta «¿cuál de las 28 es LA cuenta de ventas?» — y no hay respuesta:
// elegir una manda el ingreso de todos los servicios a la que se haya clicado.
//
// Pero el módulo sí sabe de qué servicio habla cada asiento (para eso existen
// las CLAVES) y el catálogo dice el servicio en el nombre de la cuenta. Con
// eso la pregunta se contesta sola: de las 28 candidatas de 401.01, la de
// INGRESO_QUIROFANO es la que se llama «Quirofanos».
//
// Aquí no se postea ni se guarda nada: se PROPONE.
//
//   EXACTA    ninguna otra candidata dice lo que dice ésta. Se puede aplicar
//             en bloque sin mirarla una por una.
//   PARECIDA  varias se parecen y la diferencia es de criterio —el costo de
//             farmacia al 0 % y al 16 % son dos cuentas y la clave es una—.
//             La mira una persona.
//   nada      el nombre no lo puede decir: a qué banco entran los depósitos no
//             está escrito en ninguna parte. Se enseñan las candidatas y ya.
//
// Una propuesta mala cuadra igual que una buena: el saldo queda en el renglón
// de otro servicio y la balanza no se queja. Por eso EXACTA exige que la
// segunda quede lejos, y por eso las claves cuyo nombre es genérico («material
// y equipo») no llegan nunca a EXACTA aunque algo empate.
// ─────────────────────────────────────────────────────────────────────────────

import type { ClaveMotor } from "./contabilidad";

export type Confianza = "EXACTA" | "PARECIDA";

export interface CuentaCandidata {
  id: string;
  /** El código propio de la empresa: «115001006». */
  codigo: string;
  nombre: string;
  /** Nombre de la cuenta padre; el catálogo del hospital dice ahí el servicio. */
  padre?: string | null;
}

export interface Sugerencia {
  cuenta: { id: string; codigo: string; nombre: string };
  confianza: Confianza;
  /** En una línea y en voz de quien decide: por qué ésa y no otra. */
  porque: string;
  /** Las que siguen en la lista, por si la propuesta no es la buena. */
  alternativas: Array<{ id: string; codigo: string; nombre: string }>;
}

interface Pistas {
  /** Lo que el nombre de la cuenta dice, de lo más específico a lo más general. */
  dice: string[];
  /** Desempata entre las que dicen lo mismo (vale en la cuenta y en su padre). */
  prefiere?: string[];
  /** Dice lo mismo pero es de otro servicio: se hunde. */
  evita?: string[];
  /** El nombre no alcanza para estar seguro: nunca EXACTA, siempre la mira alguien. */
  tope?: "PARECIDA";
}

/**
 * Las pistas de cada clave. Vacío = no se adivina (el nombre de una cuenta
 * bancaria no dice que ahí entran los depósitos del hospital).
 *
 * «pendiente» se evita en las retenciones porque un catálogo mexicano lleva la
 * cuenta espejo «…Pendiente de pago» junto a la buena, con el mismo agrupador.
 */
const PISTAS: Record<ClaveMotor, Pistas> = {
  INGRESO_HOSPITALIZACION: { dice: ["hospitalizacion", "habitacion", "estancia"], prefiere: ["16"], evita: ["biomedica", "uci", "cuidados intensivos", "recuperacion"] },
  INGRESO_QUIROFANO: { dice: ["quirofano", "cirugia"], evita: ["recuperacion", "esterilizacion"] },
  INGRESO_URGENCIAS: { dice: ["urgencias"] },
  // Laboratorio e imagen son dos cuentas y la clave es una: pregunta de verdad.
  INGRESO_ESTUDIOS: { dice: ["estudios", "laboratorio", "imagenologia", "rayos x", "tomografia", "ultrasonido"], tope: "PARECIDA" },
  INGRESO_FARMACIA_16: { dice: ["farmacia"], prefiere: ["16", "intrahospitalaria", "hospitalaria", "interna"], evita: ["externa"] },
  INGRESO_FARMACIA_0: { dice: ["farmacia"], prefiere: ["0", "externa", "venta directa"], evita: ["16", "intrahospitalaria", "hospitalaria", "interna"] },
  INGRESO_MATERIAL: { dice: ["material de curacion", "material", "insumo"], evita: ["biomedico"], tope: "PARECIDA" },
  INGRESO_OTROS: { dice: ["otros ingresos", "otros"], tope: "PARECIDA" },
  HONORARIOS_POR_CUENTA_DE_TERCEROS: { dice: ["honorarios medicos", "honorarios", "medicos"], evita: ["pendiente"] },
  RETENCION_ISR_HONORARIOS: { dice: ["isr"], evita: ["pendiente"] },
  RETENCION_IVA_HONORARIOS: { dice: ["iva"], evita: ["pendiente"] },
  // El costo sigue a la tasa igual que el ingreso: lo suministrado en
  // hospitalización sale del almacén interno, la venta directa de la farmacia
  // externa. Los medicamentos rotos, caducados y dañados comparten agrupador
  // pero son merma, no costo de venta.
  COSTO_FARMACIA_16: { dice: ["farmacia"], prefiere: ["16", "intrahospitalaria", "interna"], evita: ["externa", "0", "rotos", "caducados", "danados"] },
  COSTO_FARMACIA_0: { dice: ["farmacia"], prefiere: ["0", "externa", "venta directa"], evita: ["16", "intrahospitalaria", "interna", "rotos", "caducados", "danados"] },
  INVENTARIO_FARMACIA: { dice: ["farmacia"], prefiere: ["intrahospitalaria", "interna"], evita: ["externa", "carro rojo"] },
  ANTICIPOS_PACIENTES: { dice: ["anticipo", "deposito", "paciente"], tope: "PARECIDA" },
  CAJA: { dice: ["caja general", "caja admisiones", "caja", "tesoreria"], evita: ["cafeteria"], tope: "PARECIDA" },
  // Ningún nombre dice a qué banco entra el depósito del hospital, ni cuál de
  // los auxiliares de clientes es el del paciente: se enseñan y se eligen.
  BANCOS: { dice: [] },
  CLIENTES: { dice: [] },
  FONDOS_EN_TRANSITO: { dice: ["transito", "fondos"], tope: "PARECIDA" },
  COMISION_TERMINAL: { dice: ["comisiones bancarias", "comision"], evita: ["ventas"], tope: "PARECIDA" },
  IVA_ACREDITABLE: { dice: ["iva acreditable pagado", "iva acreditable"], evita: ["importacion", "pendiente"] },
};

/** Sin acentos, en minúsculas y sin signos: «Almacén Farmacia 16%» → «almacen farmacia 16». */
export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * ¿El texto dice ese término? Palabra completa, con el plural español.
 *
 * Y con la última palabra CORTADA: el sistema del hospital exporta los nombres
 * a 50 caracteres, así que «…x servicios profesionales Pendiente de pago» llega
 * como «…x servicios profesionales Pen». Sin esto, la cuenta espejo de las
 * retenciones pesa lo mismo que la buena y el empate deja la clave sin
 * propuesta. Tres letras es el mínimo para no emparejar cualquier cosa.
 */
function dice(texto: string, termino: string): boolean {
  const t = normalizar(termino);
  if (!t) return false;
  const escapado = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(^|[^a-z0-9])${escapado}e?s?([^a-z0-9]|$)`).test(texto)) return true;
  const ultima = texto.split(" ").pop() ?? "";
  return ultima.length >= 3 && ultima.length < t.length && t.startsWith(ultima);
}

interface Puntuada {
  cuenta: CuentaCandidata;
  puntos: number;
  /** El término que la eligió; es lo que se le enseña a quien decide. */
  termino: string;
}

/**
 * Qué tanto esta cuenta es la de la clave. El TÉRMINO manda sobre la forma del
 * nombre: «Laboratorio Clínico» le gana a «Tomografía» para INGRESO_ESTUDIOS
 * aunque la segunda sea idéntica al término, porque laboratorio va antes en la
 * lista. Decir el término en el nombre vale más que decirlo en el padre.
 */
function puntuar(cuenta: CuentaCandidata, pistas: Pistas): Puntuada | null {
  const nombre = normalizar(cuenta.nombre);
  const padre = normalizar(cuenta.padre ?? "");
  let mejor: Puntuada | null = null;

  for (const [i, termino] of pistas.dice.entries()) {
    const t = normalizar(termino);
    let puntos: number;
    if (nombre === t) puntos = 110 - i * 10;
    else if (dice(nombre, t)) puntos = 100 - i * 10 + (nombre.startsWith(t) ? 5 : 0);
    else if (dice(padre, t)) puntos = 70 - i * 10;
    else continue;
    // El primer término que pega manda: la lista va de lo específico a lo
    // general, y «Laboratorio Clínico» debe ganarle a «Tomografía» aunque la
    // segunda sea idéntica a su término.
    mejor = { cuenta, puntos, termino: t };
    break;
  }
  if (!mejor) return null;

  for (const p of pistas.prefiere ?? []) {
    if (dice(nombre, p)) mejor.puntos += 12;
    else if (dice(padre, p)) mejor.puntos += 8;
  }
  for (const e of pistas.evita ?? []) {
    if (dice(nombre, e) || dice(padre, e)) mejor.puntos -= 40;
  }
  return mejor.puntos > 0 ? mejor : null;
}

const resumen = (c: CuentaCandidata) => ({ id: c.id, codigo: c.codigo, nombre: c.nombre });

/**
 * La cuenta que le toca a una clave entre las candidatas de su agrupador, o
 * null si el nombre no lo puede decir. `codigo` es el agrupador, sólo para
 * explicarlo. Las candidatas deben ser cuentas de DETALLE: una acumulativa no
 * recibe pólizas.
 */
export function sugerirCuenta(clave: ClaveMotor, candidatas: CuentaCandidata[], codigo: string): Sugerencia | null {
  const pistas = PISTAS[clave];
  if (!pistas || pistas.dice.length === 0 || candidatas.length === 0) return null;

  const puntuadas = candidatas
    .map((c) => puntuar(c, pistas))
    .filter((p): p is Puntuada => p !== null)
    .sort((a, b) => b.puntos - a.puntos);
  if (puntuadas.length === 0) return null;

  const [top, segunda] = puntuadas;
  // Empate = el nombre no distingue nada. Mejor ninguna propuesta que una al azar.
  if (segunda && segunda.puntos === top.puntos) return null;

  const ventaja = segunda ? top.puntos - segunda.puntos : Infinity;
  const exacta = pistas.tope !== "PARECIDA" && top.puntos >= 70 && ventaja >= 20;
  const n = candidatas.length;

  return {
    cuenta: resumen(top.cuenta),
    confianza: exacta ? "EXACTA" : "PARECIDA",
    porque: exacta
      ? `Es la única de las ${n} cuentas con agrupador ${codigo} que dice «${top.termino}» en su nombre.`
      : `De las ${n} cuentas con agrupador ${codigo}, ésta es la más cercana («${top.termino}»), pero hay otras que se le parecen.`,
    alternativas: puntuadas.slice(1, 5).map((p) => resumen(p.cuenta)),
  };
}
