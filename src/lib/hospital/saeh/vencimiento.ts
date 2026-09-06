// ─────────────────────────────────────────────────────────────────────────────
// SAEH — cuándo hay que entregar el mes al SEUL.
//
// El calendario anual de la DGIS («Envíos mensuales de información SEUL»)
// pinta en verde los días de entrega del mes anterior y anota: «el envío se
// debe hacer el último día de cada mes en verde y antes de las 20:00 hrs».
// En los calendarios 2021-2025 el último día verde cae en los últimos dos
// días hábiles del mes siguiente al que se reporta, así que se aproxima con
// el último día hábil (lunes a viernes, sin 1 de enero ni 25 de diciembre).
// El calendario del año en curso manda si difiere: por eso `aproximado`.
// ─────────────────────────────────────────────────────────────────────────────

import { diasEntre, fechaLocal } from "../tz";

export interface VencimientoSeul {
  anio: number;
  mes: number;
  /** yyyy-mm-dd del último día verde estimado. */
  fecha: string;
  hora: "20:00";
  /** Instante límite (20:00 hora local del hospital). */
  limiteAt: Date;
  diasRestantes: number;
  vencido: boolean;
  texto: string;
  aproximado: true;
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function esFeriadoFijo(m: number, d: number): boolean {
  return (m === 1 && d === 1) || (m === 12 && d === 25);
}

/** Último día hábil (L-V) del mes (y, m) como {y, m, d}. */
export function ultimoDiaHabil(y: number, m: number): { y: number; m: number; d: number } {
  let d = new Date(Date.UTC(y, m, 0)).getUTCDate(); // último día del mes m (1-12)
  for (;;) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dow !== 0 && dow !== 6 && !esFeriadoFijo(m, d)) return { y, m, d };
    d--;
  }
}

/** Vencimiento estimado para reportar los egresos del mes (anio, mes). */
export function vencimientoSeul(anio: number, mes: number, hoy: Date = new Date()): VencimientoSeul {
  const sig = mes === 12 ? { y: anio + 1, m: 1 } : { y: anio, m: mes + 1 };
  const u = ultimoDiaHabil(sig.y, sig.m);
  const limiteAt = fechaLocal(u.y, u.m, u.d, 20, 0, 0);
  const fecha = `${u.y}-${String(u.m).padStart(2, "0")}-${String(u.d).padStart(2, "0")}`;
  const dow = new Date(Date.UTC(u.y, u.m - 1, u.d)).getUTCDay();
  const diasRestantes = diasEntre(hoy, limiteAt);
  return {
    anio,
    mes,
    fecha,
    hora: "20:00",
    limiteAt,
    diasRestantes,
    vencido: hoy.getTime() > limiteAt.getTime(),
    texto: `Reportar ${MESES[mes - 1]} de ${anio} antes del ${DIAS[dow]} ${u.d} de ${MESES[u.m - 1]} de ${u.y}, 20:00 h (último día verde del calendario SEUL, estimado)`,
    aproximado: true,
  };
}
