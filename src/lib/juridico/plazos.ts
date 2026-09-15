// ─────────────────────────────────────────────────────────────────────────────
// Cómputo de plazos. Lo único del producto que, si se equivoca, cuesta el caso.
//
// Dos principios, y el segundo importa más que el primero:
//
// 1. Los días inhábiles salen de la LEY, no de una lista que alguien tecleó.
//    Y no son los mismos en cada fuero: el amparo los fija por FECHA (Art. 19
//    de la Ley de Amparo: 5 de febrero, 21 de marzo, 20 de noviembre), mientras
//    que el laboral usa los días de descanso obligatorio, que se CONMEMORAN EN
//    LUNES (Art. 74 LFT, fracciones II, III y VI). Una implementación ingenua
//    que use una sola lista se equivoca en varios días al año, y esos días son
//    un plazo vencido.
//
// 2. El cómputo ENSEÑA SU TRABAJO y lo confirma el abogado. Devuelve el día a
//    día: cuándo surtió efectos, desde cuándo corre, qué días se saltaron y por
//    qué. Nunca se presenta como verdad silenciosa, porque el calendario del
//    órgano puede suspender labores y eso no está en ninguna ley.
// ─────────────────────────────────────────────────────────────────────────────

export type Fuero = "amparo" | "laboral" | "federal" | "local";

export type TipoDias = "habiles" | "naturales";

/** Cuándo empieza a contar respecto de la notificación. */
export type SurteEfectos = "mismo_dia" | "dia_siguiente_habil";

export interface Calendario {
  fuero: Fuero;
  /** Inhábiles del órgano: suspensión de labores, vacaciones, festivos locales. */
  inhabilesExtra: string[];
  /** Los sábados y domingos son inhábiles en todos los fueros que manejamos. */
  finDeSemanaInhabil: boolean;
}

export type ClasePaso = "notificacion" | "surte" | "cuenta" | "salta" | "recorre";

export interface PasoComputo {
  fecha: string;
  clase: ClasePaso;
  motivo: string;
  /** Cuál de los días del plazo es éste (1..n). Sólo en clase "cuenta". */
  dia?: number;
}

export interface Computo {
  vence: string;
  /** El primer día que corre. */
  inicio: string;
  dias: number;
  tipo: TipoDias;
  pasos: PasoComputo[];
  /** Lo que el abogado tiene que verificar antes de confiar. */
  advertencias: string[];
}

const DIA = 24 * 60 * 60 * 1000;

export function aISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Mediodía UTC a propósito: así ningún huso horario corre la fecha un día. */
export function deISO(s: string): Date {
  return new Date(`${s}T12:00:00Z`);
}

function sumarDias(s: string, n: number): string {
  return aISO(new Date(deISO(s).getTime() + n * DIA));
}

/** 0 = domingo … 6 = sábado. */
function diaSemana(s: string): number {
  return deISO(s).getUTCDay();
}

/** El n-ésimo lunes de un mes (n = 1 es el primero). Puro. */
export function lunesDe(anio: number, mes: number, n: number): string {
  const primero = new Date(Date.UTC(anio, mes - 1, 1, 12));
  const desplazamiento = (8 - primero.getUTCDay()) % 7; // días hasta el primer lunes
  return aISO(new Date(Date.UTC(anio, mes - 1, 1 + desplazamiento + (n - 1) * 7, 12)));
}

/** Días de descanso obligatorio del Art. 74 LFT en un año. */
function descansoObligatorio(anio: number): string[] {
  const f = (mes: number, dia: number) => aISO(new Date(Date.UTC(anio, mes - 1, dia, 12)));
  const base = [
    f(1, 1), // I. 1 de enero
    lunesDe(anio, 2, 1), // II. primer lunes de febrero en conmemoración del 5 de febrero
    lunesDe(anio, 3, 3), // III. tercer lunes de marzo en conmemoración del 21 de marzo
    f(5, 1), // V. 1 de mayo
    f(9, 16), // VI. 16 de septiembre
    lunesDe(anio, 11, 3), // VII. tercer lunes de noviembre en conmemoración del 20 de noviembre
    f(12, 25), // IX. 25 de diciembre
  ];
  // VIII. 1 de octubre de cada seis años, por la transmisión del Poder Ejecutivo.
  if ((anio - 2024) % 6 === 0) base.push(f(10, 1));
  return base.sort();
}

/**
 * Inhábiles que fija la ley para el fuero, en un año.
 *
 * Amparo — Art. 19 de la Ley de Amparo, por FECHA y sin mover al lunes.
 * Laboral — Arts. 715 y 74 de la LFT: los de descanso obligatorio.
 * Federal y local — se parte del descanso obligatorio, que es el piso común, y
 * el despacho completa con el calendario de su órgano. Aquí NO se inventa el
 * acuerdo del Consejo de la Judicatura ni la ley orgánica de cada estado.
 */
export function inhabilesDeLey(fuero: Fuero, anio: number): string[] {
  if (fuero !== "amparo") return descansoObligatorio(anio);
  const f = (mes: number, dia: number) => aISO(new Date(Date.UTC(anio, mes - 1, dia, 12)));
  return [f(1, 1), f(2, 5), f(3, 21), f(5, 1), f(5, 5), f(9, 14), f(9, 16), f(10, 12), f(11, 20), f(12, 25)];
}

/** ¿Este día cuenta? Devuelve también por qué no. Puro. */
export function esHabil(fecha: string, cal: Calendario): { habil: boolean; motivo: string } {
  const d = diaSemana(fecha);
  if (cal.finDeSemanaInhabil && (d === 0 || d === 6)) {
    return { habil: false, motivo: d === 0 ? "domingo" : "sábado" };
  }
  if (cal.inhabilesExtra.includes(fecha)) {
    return { habil: false, motivo: "inhábil del órgano (suspensión de labores o vacaciones)" };
  }
  if (inhabilesDeLey(cal.fuero, deISO(fecha).getUTCFullYear()).includes(fecha)) {
    return {
      habil: false,
      motivo: cal.fuero === "amparo" ? "inhábil por el Art. 19 de la Ley de Amparo" : "día de descanso obligatorio (Art. 74 LFT)",
    };
  }
  return { habil: true, motivo: "hábil" };
}

export interface EntradaComputo {
  /** Día en que se practicó la notificación (AAAA-MM-DD). */
  notificacion: string;
  dias: number;
  tipo?: TipoDias;
  surteEfectos?: SurteEfectos;
  calendario: Calendario;
}

/**
 * El cómputo, con su rastro. La regla general: la notificación surte efectos, y
 * el plazo corre a partir del día siguiente al que surtió. Cuándo surte depende
 * del fuero y del tipo de notificación, así que entra como dato y se advierte.
 */
export function computarPlazo(e: EntradaComputo): Computo {
  const tipo: TipoDias = e.tipo ?? "habiles";
  const dias = Math.max(1, Math.floor(e.dias));
  const surte: SurteEfectos = e.surteEfectos ?? (e.calendario.fuero === "amparo" ? "dia_siguiente_habil" : "mismo_dia");
  const pasos: PasoComputo[] = [{ fecha: e.notificacion, clase: "notificacion", motivo: "se practicó la notificación" }];

  // 1. Cuándo surte efectos la notificación.
  let fechaSurte = e.notificacion;
  if (surte === "dia_siguiente_habil") {
    fechaSurte = sumarDias(e.notificacion, 1);
    while (!esHabil(fechaSurte, e.calendario).habil) fechaSurte = sumarDias(fechaSurte, 1);
    pasos.push({ fecha: fechaSurte, clase: "surte", motivo: "surte efectos la notificación" });
  } else {
    pasos.push({ fecha: fechaSurte, clase: "surte", motivo: "surte efectos el mismo día" });
  }

  // 2. El plazo corre desde el día siguiente al que surtió efectos.
  let cursor = sumarDias(fechaSurte, 1);
  let contados = 0;
  let inicio = "";
  let guarda = 0;
  while (contados < dias && guarda++ < 3650) {
    if (tipo === "naturales") {
      contados++;
      if (!inicio) inicio = cursor;
      pasos.push({ fecha: cursor, clase: "cuenta", motivo: "día natural", dia: contados });
    } else {
      const h = esHabil(cursor, e.calendario);
      if (h.habil) {
        contados++;
        if (!inicio) inicio = cursor;
        pasos.push({ fecha: cursor, clase: "cuenta", motivo: h.motivo, dia: contados });
      } else {
        pasos.push({ fecha: cursor, clase: "salta", motivo: h.motivo });
      }
    }
    if (contados < dias) cursor = sumarDias(cursor, 1);
  }

  // 3. Un plazo en días naturales que vence en inhábil se recorre al siguiente hábil.
  const advertencias: string[] = [];
  let vence = cursor;
  if (tipo === "naturales") {
    const h = esHabil(vence, e.calendario);
    if (!h.habil) {
      const original = vence;
      while (!esHabil(vence, e.calendario).habil) vence = sumarDias(vence, 1);
      pasos.push({ fecha: vence, clase: "recorre", motivo: `el plazo vencía el ${original} (${h.motivo}) y se recorre al siguiente hábil` });
      advertencias.push("El vencimiento cayó en día inhábil y se recorrió al siguiente hábil; confirma que tu órgano aplica esa regla.");
    }
  }
  advertencias.push(
    surte === "dia_siguiente_habil"
      ? "Se tomó que la notificación surte efectos al día hábil siguiente; verifica la regla de tu vía y del tipo de notificación."
      : "Se tomó que la notificación surte efectos el mismo día; verifica la regla de tu vía y del tipo de notificación.",
  );
  if (e.calendario.inhabilesExtra.length === 0) {
    advertencias.push("No hay inhábiles del órgano cargados: faltan las suspensiones de labores y los periodos de vacaciones, que ninguna ley lista.");
  }
  return { vence, inicio: inicio || vence, dias, tipo, pasos, advertencias };
}

/** Días hábiles que faltan para el vencimiento, para pintar la urgencia. Puro. */
export function diasHabilesRestantes(vence: string, cal: Calendario, hoy: string): number {
  if (vence <= hoy) return 0;
  let n = 0;
  let cursor = sumarDias(hoy, 1);
  let guarda = 0;
  while (cursor <= vence && guarda++ < 3650) {
    if (esHabil(cursor, cal).habil) n++;
    cursor = sumarDias(cursor, 1);
  }
  return n;
}

/** Una frase que explica el cómputo sin abrir la tabla. Pura. */
export function explicacion(c: Computo): string {
  const saltados = c.pasos.filter((p) => p.clase === "salta").length;
  const cola = saltados > 0 ? `, saltando ${saltados} día${saltados === 1 ? "" : "s"} inhábil${saltados === 1 ? "" : "es"}` : "";
  return `${c.dias} días ${c.tipo === "habiles" ? "hábiles" : "naturales"} desde el ${c.inicio}; vence el ${c.vence}${cola}.`;
}
