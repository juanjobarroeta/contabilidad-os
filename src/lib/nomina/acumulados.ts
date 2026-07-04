// ─────────────────────────────────────────────────────────────────────────────
// Acumulados del ejercicio por empleado — funciones PURAS (sin DB / red).
//
// Suman los PayrollItem de un empleado (nativos de la app e importados del
// SAT por historia-import) para responder «¿cuánto percibió y cuánto se le
// retuvo en el ejercicio X?». Son la base del expediente del empleado y el
// cimiento del futuro ajuste anual de ISR (Art. 97 LISR): el ajuste parte de
// estos mismos acumulados por ejercicio.
//
// Nota de alcance: PayrollItem NO conserva el desglose gravado/exento por
// percepción ni el subsidio al empleo entregado (el complemento los trae,
// pero el modelo los colapsa por columna). Por eso aquí se acumulan importes
// TOTALES por concepto; gravado/exento y subsidio quedan fuera hasta que se
// persistan por recibo.
//
// El ejercicio de un recibo es el AÑO (UTC) de la fecha de pago de su corrida
// — mismo criterio que usa el SAT para atribuir la nómina a un ejercicio.
// ─────────────────────────────────────────────────────────────────────────────

/** Subconjunto de PayrollItem (+ datos de su corrida) que necesita el acumulado. */
export interface ReciboAcumulable {
  /** Fecha de pago de la corrida (PayrollRun.fechaPago). Define el ejercicio. */
  fechaPago: Date | string;
  /** Procedencia de la corrida: "APP" (nativa) o "SAT" (importada). */
  origen?: string | null;
  // Percepciones
  sueldoBase: number;
  horasExtra: number;
  bonosPagoFijo: number;
  bonosPagoVar: number;
  vales: number;
  otrasPercepciones: number;
  aguinaldo: number;
  primaVacacional: number;
  vacaciones: number;
  ptu: number;
  // Deducciones
  isrRetenido: number;
  imssObrero: number;
  infonavit: number;
  otrasDeducc: number;
  // Totales del recibo
  totalPercepciones: number;
  totalDeducciones: number;
  netoAPagar: number;
}

export interface AcumuladosEmpleado {
  /** Ejercicio acumulado, o null si se sumó todo el historial sin filtrar. */
  anio: number | null;
  /** Número de recibos considerados. */
  recibos: number;
  /** Recibos por procedencia (APP = nativos, SAT = importados del histórico). */
  porOrigen: { app: number; sat: number };
  percepciones: {
    sueldo: number;
    horasExtra: number;
    bonosFijos: number;
    bonosVariables: number;
    vales: number;
    aguinaldo: number;
    primaVacacional: number;
    vacaciones: number;
    ptu: number;
    otras: number;
    total: number;
  };
  deducciones: {
    isrRetenido: number;
    imssObrero: number;
    infonavit: number;
    otras: number;
    total: number;
  };
  netoPagado: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Ejercicio fiscal de un recibo: año UTC de la fecha de pago. */
export function anioDePago(fechaPago: Date | string): number {
  const d = typeof fechaPago === "string" ? new Date(fechaPago) : fechaPago;
  return d.getUTCFullYear();
}

/**
 * Años (ejercicios) con al menos un recibo, ordenados del más reciente al
 * más antiguo — alimenta el selector de ejercicio del expediente.
 */
export function aniosConRecibos(items: Pick<ReciboAcumulable, "fechaPago">[]): number[] {
  const set = new Set(items.map((i) => anioDePago(i.fechaPago)));
  return [...set].sort((a, b) => b - a);
}

/**
 * Acumula los recibos de UN empleado. Si se pasa `anio`, sólo suma los
 * recibos cuya fecha de pago cae en ese ejercicio (año UTC); si se omite,
 * suma todo el historial recibido (anio = null en el resultado).
 */
export function acumuladosEmpleado(items: ReciboAcumulable[], anio?: number): AcumuladosEmpleado {
  const delEjercicio =
    anio == null ? items : items.filter((i) => anioDePago(i.fechaPago) === anio);

  const acc: AcumuladosEmpleado = {
    anio: anio ?? null,
    recibos: delEjercicio.length,
    porOrigen: { app: 0, sat: 0 },
    percepciones: {
      sueldo: 0,
      horasExtra: 0,
      bonosFijos: 0,
      bonosVariables: 0,
      vales: 0,
      aguinaldo: 0,
      primaVacacional: 0,
      vacaciones: 0,
      ptu: 0,
      otras: 0,
      total: 0,
    },
    deducciones: { isrRetenido: 0, imssObrero: 0, infonavit: 0, otras: 0, total: 0 },
    netoPagado: 0,
  };

  for (const i of delEjercicio) {
    if (i.origen === "SAT") acc.porOrigen.sat++;
    else acc.porOrigen.app++;

    acc.percepciones.sueldo += i.sueldoBase;
    acc.percepciones.horasExtra += i.horasExtra;
    acc.percepciones.bonosFijos += i.bonosPagoFijo;
    acc.percepciones.bonosVariables += i.bonosPagoVar;
    acc.percepciones.vales += i.vales;
    acc.percepciones.aguinaldo += i.aguinaldo;
    acc.percepciones.primaVacacional += i.primaVacacional;
    acc.percepciones.vacaciones += i.vacaciones;
    acc.percepciones.ptu += i.ptu;
    acc.percepciones.otras += i.otrasPercepciones;
    acc.percepciones.total += i.totalPercepciones;

    acc.deducciones.isrRetenido += i.isrRetenido;
    acc.deducciones.imssObrero += i.imssObrero;
    acc.deducciones.infonavit += i.infonavit;
    acc.deducciones.otras += i.otrasDeducc;
    acc.deducciones.total += i.totalDeducciones;

    acc.netoPagado += i.netoAPagar;
  }

  // Redondeo a centavos al final (evita arrastrar ruido binario de los floats).
  for (const k of Object.keys(acc.percepciones) as (keyof typeof acc.percepciones)[]) {
    acc.percepciones[k] = round2(acc.percepciones[k]);
  }
  for (const k of Object.keys(acc.deducciones) as (keyof typeof acc.deducciones)[]) {
    acc.deducciones[k] = round2(acc.deducciones[k]);
  }
  acc.netoPagado = round2(acc.netoPagado);

  return acc;
}
