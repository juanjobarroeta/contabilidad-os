// ─────────────────────────────────────────────────────────────────────────────
// LA AGENDA DEL SAT: cuándo ir a buscar cada cosa, como lo haría un contador.
//
// Un contador no revisa el buzón cada 4 horas todo el mes. Sabe que la
// declaración vence el 17, que la mayoría se presenta ese día o un poco antes,
// y que si el 18 no aparece el acuse algo pasó: vuelve esa noche, luego a
// diario unos días, luego cada tanto, y en algún momento le levanta la mano al
// cliente. Eso es este módulo: dado un entregable, su periodo y lo que salió en
// la última revisión, decide la próxima y si hay que avisar.
//
// PURO: sin prisma ni reloj. Todo lo que depende del SAT o de la base vive en
// ejecutar.ts; aquí sólo fechas.
//
// Horas en hora del centro de México. Desde oct-2022 no hay horario de verano:
// UTC−6 fijo todo el año, así que un desfase constante es exacto.
// ─────────────────────────────────────────────────────────────────────────────

import {
  addBusinessDays,
  calcularVencimiento,
  diasHabilesExtraPorRfc,
  esDiaInhabilCff,
  nextBusinessDay,
} from "@/lib/obligaciones";

export type Entregable =
  /** Acuse de la declaración mensual (IVA/ISR/retenciones), vía SatGo decfiel. */
  | "DECLARACION_MENSUAL"
  /** Balanza de comprobación de la Contabilidad Electrónica (Anexo 24). */
  | "BALANZA_CE"
  /** Opinión 32-D + CSF del mes, después de que venció la declaración. */
  | "CUMPLIMIENTO";

export const ENTREGABLES: readonly Entregable[] = ["DECLARACION_MENSUAL", "BALANZA_CE", "CUMPLIMIENTO"] as const;

export type EstadoAgenda =
  | "PENDIENTE"
  /** Pasó la fecha y el SAT no lo tiene: hay un pendiente abierto en el expediente. */
  | "TARDE"
  | "ENCONTRADO"
  /** La empresa no tiene esa obligación. */
  | "NO_APLICA"
  /** 90 días sin encontrarlo: se deja de insistir; el pendiente sigue abierto. */
  | "ABANDONADO";

export const ESTADOS_ACTIVOS: readonly EstadoAgenda[] = ["PENDIENTE", "TARDE"] as const;

export type ResultadoRevision =
  | "encontrado"
  | "no_encontrado"
  | "no_aplica"
  /** Sólo CUMPLIMIENTO: la opinión salió negativa (el hallazgo lo abre diff.ts). */
  | "negativa"
  /** Falla nuestra o del SAT: no dice nada sobre si se presentó. */
  | "error";

const OFFSET_MX_H = 6;
const DIA_MS = 24 * 60 * 60 * 1000;

/** Un día de calendario (año, mes 1–12, día). Sin zona: es una fecha, no un instante. */
export interface Dia {
  y: number;
  m: number;
  d: number;
}

function diaDeDate(x: Date): Dia {
  return { y: x.getFullYear(), m: x.getMonth() + 1, d: x.getDate() };
}
function dateDeDia(x: Dia): Date {
  return new Date(x.y, x.m - 1, x.d);
}
function sumarDias(x: Dia, n: number): Dia {
  return diaDeDate(new Date(x.y, x.m - 1, x.d + n));
}

/** El instante (UTC) de las `hora`:00 del día `x` en el centro de México. */
export function enMx(x: Dia, hora: number): Date {
  return new Date(Date.UTC(x.y, x.m - 1, x.d, hora + OFFSET_MX_H));
}

/** El día de calendario en México de un instante, y su hora local. */
export function diaMx(t: Date): Dia & { hora: number } {
  const l = new Date(t.getTime() - OFFSET_MX_H * 60 * 60 * 1000);
  return { y: l.getUTCFullYear(), m: l.getUTCMonth() + 1, d: l.getUTCDate(), hora: l.getUTCHours() };
}

function diasEntre(a: Dia, b: Dia): number {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / DIA_MS);
}

/** Persona física: RFC de 13 caracteres. */
export function esPersonaFisica(rfc: string): boolean {
  return rfc.trim().length === 13;
}

function mesSiguiente(periodo: string, n: number): { y: number; m: number } {
  const [y, m] = periodo.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  return { y: Math.floor(idx / 12), m: (idx % 12) + 1 };
}

function restarDiasHabiles(x: Dia, n: number): Dia {
  const d = dateDeDia(x);
  let faltan = n;
  while (faltan > 0) {
    d.setDate(d.getDate() - 1);
    if (!esDiaInhabilCff(d)) faltan -= 1;
  }
  return diaDeDate(d);
}

/**
 * La fecha límite de un entregable.
 *
 * - DECLARACION_MENSUAL: día 17 del mes siguiente (Art. 5-D LIVA, 14 LISR),
 *   recorrido al hábil (Art. 12 CFF). La persona física suma los días hábiles
 *   del sexto dígito del RFC (Decreto DOF 26-dic-2013, art. 5.1): la agenda
 *   prefiere la fecha más tardía posible para no acusar de tarde a quien no lo
 *   está.
 * - BALANZA_CE: día 3 (moral) o 5 (física) del SEGUNDO mes posterior
 *   (regla 2.8.1.6 RMF), recorrido al hábil.
 * - CUMPLIMIENTO: no es una obligación: es cuándo vale la pena pedir la 32-D.
 *   El SAT tarda en reflejar lo presentado, así que se pide 3 días hábiles
 *   después del vencimiento de la declaración.
 */
export function venceEntregable(entregable: Entregable, periodo: string, rfc: string): Dia {
  const pf = esPersonaFisica(rfc);
  if (entregable === "BALANZA_CE") {
    const { y, m } = mesSiguiente(periodo, 2);
    return diaDeDate(nextBusinessDay(new Date(y, m - 1, pf ? 5 : 3)));
  }
  const decl = diaDeDate(
    calcularVencimiento(
      { tipo: "DECLARACION", descripcion: "", periodicidad: "MENSUAL", diaVencimiento: 17 },
      periodo,
      { diasHabilesAdicionales: pf ? (diasHabilesExtraPorRfc(rfc) ?? 0) : 0 },
    ),
  );
  if (entregable === "CUMPLIMIENTO") return diaDeDate(addBusinessDays(dateDeDia(decl), 3));
  return decl;
}

/**
 * La primera revisión. Declaración y balanza: una temprana, 3 días hábiles
 * antes a las 21:00 (quien presenta antes se ve antes y el cierre tiene datos
 * del SAT días antes), y luego la noche del vencimiento. Cumplimiento: a las
 * 10:00 del día que vale la pena pedirlo.
 */
export function primeraRevision(entregable: Entregable, vence: Dia): Date {
  if (entregable === "CUMPLIMIENTO") return enMx(vence, 10);
  return enMx(restarDiasHabiles(vence, 3), 21);
}

export interface EstadoRevision {
  entregable: Entregable;
  vence: Dia;
  estado: EstadoAgenda;
  intentos: number;
  /** Errores SEGUIDOS: un error no dice si se presentó, así que no cuenta como «no está». */
  errores: number;
}

export interface Decision {
  estado: EstadoAgenda;
  proximaRevision: Date | null;
  intentos: number;
  errores: number;
  /** Abrir un pendiente en el expediente: acaba de volverse tarde. */
  escalar: boolean;
  /** Cerrar el pendiente abierto: ya apareció o ya no aplica. */
  desescalar: boolean;
  /** Por qué esa próxima fecha, en palabras (queda en la fila). */
  motivo: string;
}

const MAX_ERRORES_SEGUIDOS = 3;
const REINTENTO_ERROR_MS = 2 * 60 * 60 * 1000;
const MAX_NEGATIVAS = 5;

/**
 * La cadencia después del vencimiento, cuando el SAT todavía no lo tiene.
 * D = día de vencimiento.
 *   antes de la noche de D       → la noche de D (22:00)
 *   la noche de D                → D+1 a las 10:00 (lo presentado de madrugada)
 *   D+1 en la mañana             → D+1 a las 21:00
 *   hasta D + 5 días hábiles     → cada noche a las 21:00
 *   hasta D + 30                 → cada 3 días
 *   hasta D + 90                 → cada semana
 *   después                      → se deja de buscar
 */
function cadenciaTrasVencimiento(vence: Dia, ahora: Date): { cuando: Date | null; motivo: string } {
  const nocheD = enMx(vence, 22);
  if (ahora.getTime() < nocheD.getTime()) return { cuando: nocheD, motivo: "la noche del vencimiento" };
  const hoy = diaMx(ahora);
  const k = diasEntre(vence, hoy);
  if (k <= 0) return { cuando: enMx(sumarDias(vence, 1), 10), motivo: "la mañana siguiente al vencimiento" };
  if (k === 1 && hoy.hora < 21) return { cuando: enMx(sumarDias(vence, 1), 21), motivo: "la noche siguiente al vencimiento" };
  const finDiario = diaDeDate(addBusinessDays(dateDeDia(vence), 5));
  if (diasEntre(hoy, finDiario) > 0) return { cuando: enMx(sumarDias(hoy, 1), 21), motivo: "cada noche, la primera semana" };
  if (k < 30) return { cuando: enMx(sumarDias(hoy, 3), 21), motivo: "cada 3 días, el primer mes" };
  if (k < 90) return { cuando: enMx(sumarDias(hoy, 7), 21), motivo: "cada semana, hasta 90 días" };
  return { cuando: null, motivo: "90 días sin encontrarlo" };
}

/** ¿Ya es tarde? Desde la noche del día siguiente al vencimiento: el SAT puede tardar horas en servir un acuse. */
export function esTarde(vence: Dia, ahora: Date): boolean {
  return ahora.getTime() >= enMx(sumarDias(vence, 1), 21).getTime();
}

/** Qué sigue después de una revisión. */
export function siguienteRevision(e: EstadoRevision, resultado: ResultadoRevision, ahora: Date): Decision {
  const intentos = e.intentos + 1;
  const eraTarde = e.estado === "TARDE";
  const terminal = (estado: EstadoAgenda, motivo: string): Decision => ({
    estado,
    proximaRevision: null,
    intentos,
    errores: 0,
    escalar: false,
    desescalar: eraTarde,
    motivo,
  });

  if (resultado === "encontrado") return terminal("ENCONTRADO", "encontrado en el SAT");
  if (resultado === "no_aplica") return terminal("NO_APLICA", "la empresa no tiene esa obligación");

  if (resultado === "error") {
    const errores = e.errores + 1;
    if (errores < MAX_ERRORES_SEGUIDOS) {
      return {
        estado: e.estado,
        proximaRevision: new Date(ahora.getTime() + REINTENTO_ERROR_MS),
        intentos,
        errores,
        escalar: false,
        desescalar: false,
        motivo: `error ${errores}/${MAX_ERRORES_SEGUIDOS}: reintento en 2 h`,
      };
    }
    // Tres errores seguidos: se vuelve a la cadencia normal, SIN acusar de
    // tarde — un SAT caído no es una declaración omitida.
    const c = e.entregable === "CUMPLIMIENTO"
      ? { cuando: enMx(sumarDias(diaMx(ahora), 1), 10), motivo: "errores seguidos: mañana" }
      : cadenciaTrasVencimiento(e.vence, ahora);
    return {
      estado: e.estado,
      proximaRevision: c.cuando ?? enMx(sumarDias(diaMx(ahora), 7), 21),
      intentos,
      errores: 0,
      escalar: false,
      desescalar: false,
      motivo: `errores seguidos; ${c.motivo}`,
    };
  }

  if (e.entregable === "CUMPLIMIENTO") {
    // Negativa: el hallazgo ya lo abre diff.ts. Se vuelve a pedir cada semana
    // por si se corrige; tras 5 se deja (la opinión está guardada).
    if (resultado === "negativa" && intentos < MAX_NEGATIVAS) {
      return {
        estado: "PENDIENTE",
        proximaRevision: enMx(sumarDias(diaMx(ahora), 7), 10),
        intentos,
        errores: 0,
        escalar: false,
        desescalar: false,
        motivo: "opinión negativa: se revisa cada semana",
      };
    }
    if (resultado === "negativa") return terminal("ENCONTRADO", "opinión negativa tras 5 revisiones");
    // no_encontrado en cumplimiento: el SAT no la emitió; mañana.
    return {
      estado: "PENDIENTE",
      proximaRevision: enMx(sumarDias(diaMx(ahora), 1), 10),
      intentos,
      errores: 0,
      escalar: false,
      desescalar: false,
      motivo: "sin opinión: mañana",
    };
  }

  // no_encontrado (o negativa, que no aplica aquí): declaración o balanza.
  const tarde = esTarde(e.vence, ahora);
  // Antes del vencimiento, tras la revisión temprana: la noche de D.
  const c = cadenciaTrasVencimiento(e.vence, ahora);
  if (c.cuando == null) {
    return { estado: "ABANDONADO", proximaRevision: null, intentos, errores: 0, escalar: false, desescalar: false, motivo: c.motivo };
  }
  return {
    estado: tarde ? "TARDE" : "PENDIENTE",
    proximaRevision: c.cuando,
    intentos,
    errores: 0,
    escalar: tarde && !eraTarde,
    desescalar: false,
    motivo: c.motivo,
  };
}

/** Periodos «AAAA-MM» de los `n` meses cerrados antes de `ahora` (en México), empezando `desde` meses atrás. */
export function periodosCerrados(ahora: Date, desde: number, n: number): string[] {
  const hoy = diaMx(ahora);
  const out: string[] = [];
  for (let i = desde; i < desde + n; i++) {
    const idx = hoy.y * 12 + (hoy.m - 1) - i;
    out.push(`${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`);
  }
  return out;
}

/** «17-sep-2026». */
export function fechaCorta(x: Dia): string {
  const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  return `${x.d}-${MESES[x.m - 1]}-${x.y}`;
}

/** «agosto 2026». */
export function periodoLargo(periodo: string): string {
  const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const [y, m] = periodo.split("-").map(Number);
  return `${MESES[m - 1]} ${y}`;
}
