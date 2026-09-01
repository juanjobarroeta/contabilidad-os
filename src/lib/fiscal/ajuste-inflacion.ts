// ─────────────────────────────────────────────────────────────────────────────
// AJUSTE ANUAL POR INFLACIÓN (Arts. 44, 45 y 46 LISR) — motor puro.
//
// Hasta ahora la anual de PM pedía las dos cifras del ajuste como CAPTURA
// MANUAL, con default "0". En la práctica nadie las capturaba: toda anual salía
// con ajuste cero, que es el hueco de corrección más grande del cálculo. Y es
// un dato que YA tenemos: sale de los saldos mensuales del propio ledger.
//
// Mecánica (Art. 44):
//   1. Saldo promedio anual de CRÉDITOS y de DEUDAS = suma de los saldos al
//      último día de cada mes del ejercicio ÷ número de meses del ejercicio.
//   2. Si deudas > créditos → la diferencia × factor es ajuste ACUMULABLE
//      (ingreso: la inflación licuó lo que debes).
//   3. Si créditos > deudas → la diferencia × factor es ajuste DEDUCIBLE
//      (deducción: la inflación licuó lo que te deben).
//
// El factor de ajuste anual sale del INPC, no de una tabla nueva.
//
// LO QUE ESTE MOTOR NO PUEDE DECIDIR SOLO. Los Arts. 45 y 46 excluyen partidas
// por HECHOS que el catálogo de cuentas no conoce: si un deudor diverso es un
// socio o un empleado (Art. 45, fracs. II y III), si un cobro anticipado es en
// numerario o en especie. Por eso cada cuenta trae, además de su clase por
// defecto, su FUNDAMENTO y una marca `revisar` cuando la ley depende de esos
// hechos. La clasificación se propone; el contador la confirma o la corrige.
//
// PURO: recibe saldos mensuales ya leídos del ledger y devuelve el cálculo.
// ─────────────────────────────────────────────────────────────────────────────

import { inpc } from "./inpc";

/** Qué papel juega una cuenta en el ajuste. */
export type ClaseAjuste = "CREDITO" | "DEUDA" | "EXCLUIDA";

export interface ReglaClasificacion {
  clase: ClaseAjuste;
  /** Por qué — el artículo y fracción que la sustenta. */
  fundamento: string;
  /**
   * true cuando la ley depende de hechos fuera del catálogo (quién es el
   * deudor, si la obligación es en numerario). El panel las destaca.
   */
  revisar: boolean;
}

const R = (clase: ClaseAjuste, fundamento: string, revisar = false): ReglaClasificacion => ({
  clase,
  fundamento,
  revisar,
});

// Reglas por SUBCUENTA — ganan sobre las de cuenta. Son las excepciones que la
// ley pone dentro de un mismo grupo del código agrupador.
const POR_SUBCUENTA: Record<string, ReglaClasificacion> = {
  // El ISR propio NO es deuda: Art. 46 último párrafo excluye las originadas
  // por partidas no deducibles del Art. 28 frac. I, que es justamente el ISR a
  // cargo del contribuyente.
  "213.03": R("EXCLUIDA", "Art. 46 último párrafo y Art. 28 frac. I LISR: el ISR propio no es deuda"),
  // Art. 46 primer párrafo las nombra expresamente como deuda, aunque vivan en
  // el capital contable.
  "301.03": R("DEUDA", "Art. 46 primer párrafo LISR: aportaciones para futuros aumentos de capital"),
};

// Reglas por CUENTA (grupo del código agrupador). Lo no listado queda EXCLUIDA.
const POR_CUENTA: Record<string, ReglaClasificacion> = {
  // ── Créditos (Art. 45) ────────────────────────────────────────────────────
  "102": R("CREDITO", "Art. 45 LISR: depósitos en instituciones de crédito"),
  "103": R("CREDITO", "Art. 45 LISR: inversiones; excluye acciones y partes sociales", true),
  "104": R("CREDITO", "Art. 45 LISR: otros instrumentos financieros; revisar si son acciones", true),
  "105": R("CREDITO", "Art. 45 LISR: derecho a recibir efectivo de clientes"),
  "106": R("CREDITO", "Art. 45 LISR: cuentas y documentos por cobrar; excluye los a cargo de personas físicas no empresariales (frac. I)", true),
  "107": R("CREDITO", "Art. 45 fracs. II y III LISR: excluye los a cargo de socios, accionistas, funcionarios y empleados", true),
  "184": R("CREDITO", "Art. 45 LISR: depósitos en garantía recuperables en efectivo", true),
  "186": R("CREDITO", "Art. 45 LISR: cuentas y documentos por cobrar a largo plazo", true),

  // ── Exclusiones del lado del activo ───────────────────────────────────────
  "101": R("EXCLUIDA", "Art. 45 frac. VI LISR: el efectivo en caja no es crédito"),
  "108": R("EXCLUIDA", "Cuenta de valuación: el crédito ya se computa por su importe bruto en clientes"),
  "109": R("EXCLUIDA", "Art. 45 LISR: un pago anticipado da derecho a bienes o servicios, no a recibir efectivo"),
  "110": R("EXCLUIDA", "Art. 45 frac. IV LISR: estímulos fiscales"),
  "111": R("EXCLUIDA", "Art. 45 frac. IV LISR: estímulos fiscales"),
  "112": R("EXCLUIDA", "Art. 45 frac. IV LISR: estímulos fiscales"),
  "113": R("EXCLUIDA", "Art. 45 frac. V LISR: saldos a favor de contribuciones"),
  "114": R("EXCLUIDA", "Art. 45 frac. IV LISR: pagos provisionales de impuestos"),
  "118": R("EXCLUIDA", "Art. 45 frac. IV LISR: impuestos acreditables (IVA) no son crédito"),
  "119": R("EXCLUIDA", "Art. 45 frac. IV LISR: impuestos acreditables (IVA) no son crédito"),
  "120": R("EXCLUIDA", "Art. 45 LISR: el anticipo a proveedores da derecho a bienes, no a efectivo"),
  "188": R("EXCLUIDA", "Art. 45 LISR: las acciones no se consideran créditos"),
  "190": R("EXCLUIDA", "Art. 45 LISR: revisar si el instrumento da derecho a recibir efectivo", true),

  // ── Deudas (Art. 46) ──────────────────────────────────────────────────────
  "201": R("DEUDA", "Art. 46 LISR: obligación en numerario con proveedores"),
  "202": R("DEUDA", "Art. 46 LISR: cuentas por pagar a corto plazo"),
  "204": R("DEUDA", "Art. 46 LISR: instrumentos financieros pasivos", true),
  "205": R("DEUDA", "Art. 46 LISR: acreedores diversos"),
  "208": R("DEUDA", "Art. 46 segundo párrafo LISR: contribución causada, desde el último día del periodo hasta que deba pagarse"),
  "210": R("DEUDA", "Art. 46 LISR: sueldos y salarios devengados por pagar"),
  "211": R("DEUDA", "Art. 46 segundo párrafo LISR: contribuciones de seguridad social causadas"),
  "212": R("DEUDA", "Art. 46 segundo párrafo LISR: impuesto estatal sobre nóminas causado"),
  "213": R("DEUDA", "Art. 46 segundo párrafo LISR: contribuciones causadas (el ISR propio va excluido aparte)", true),
  "214": R("DEUDA", "Art. 46 LISR: dividendos decretados pendientes de pago"),
  "215": R("DEUDA", "Art. 46 LISR: PTU determinada pendiente de pago", true),
  "216": R("DEUDA", "Art. 46 LISR: retenciones enteradas al fisco; revisar contra Art. 28 frac. I", true),
  "218": R("DEUDA", "Art. 46 LISR: otros pasivos a corto plazo", true),
  "251": R("DEUDA", "Art. 46 LISR: acreedores diversos a largo plazo"),
  "252": R("DEUDA", "Art. 46 LISR: cuentas por pagar a largo plazo"),
  "254": R("DEUDA", "Art. 46 LISR: instrumentos financieros pasivos a largo plazo", true),
  "255": R("DEUDA", "Art. 46 LISR: beneficios a empleados a largo plazo", true),
  "256": R("DEUDA", "Art. 46 LISR: otros pasivos a largo plazo", true),
  "258": R("DEUDA", "Art. 46 LISR: obligaciones contraídas de fideicomisos", true),

  // ── Exclusiones del lado del pasivo ───────────────────────────────────────
  "203": R("EXCLUIDA", "Art. 46 LISR: un cobro anticipado obliga a entregar bienes, no numerario", true),
  "206": R("EXCLUIDA", "Art. 46 LISR: el anticipo de cliente obliga a entregar bienes, no numerario", true),
  "207": R("EXCLUIDA", "Art. 46 segundo párrafo LISR: sólo la parte causada y exigible es deuda", true),
  "209": R("EXCLUIDA", "IVA trasladado no cobrado: bajo flujo aún no es contribución causada", true),
  "217": R("EXCLUIDA", "Art. 46 LISR: pagos por cuenta de terceros; revisar si hay obligación propia en numerario", true),
  "253": R("EXCLUIDA", "Art. 46 LISR: cobros anticipados a largo plazo", true),
  "257": R("EXCLUIDA", "PTU diferida: pasivo contable sin obligación exigible en numerario"),
  "259": R("EXCLUIDA", "Impuestos diferidos: pasivo contable sin obligación exigible en numerario"),
  "260": R("EXCLUIDA", "Pasivos diferidos: sin obligación exigible en numerario", true),
};

/**
 * Clase por defecto de una cuenta. La subcuenta gana sobre el grupo; lo que no
 * aparece en ninguna tabla queda EXCLUIDA (criterio conservador: sólo entra al
 * ajuste lo que la ley nombra).
 */
export function clasificacionPorDefecto(cuentaSAT: string, subcuenta: string | null): ReglaClasificacion {
  if (subcuenta && POR_SUBCUENTA[subcuenta]) return POR_SUBCUENTA[subcuenta];
  if (POR_CUENTA[cuentaSAT]) return POR_CUENTA[cuentaSAT];
  return R("EXCLUIDA", "Sin regla: no es crédito del Art. 45 ni deuda del Art. 46");
}

/** Clave estable de una cuenta para overrides (la subcuenta si existe). */
export function claveCuenta(cuentaSAT: string, subcuenta: string | null): string {
  return subcuenta ?? cuentaSAT;
}

/**
 * Saldo promedio anual (Art. 44 frac. I): suma de los saldos al último día de
 * cada mes del ejercicio ÷ número de meses del ejercicio.
 */
export function saldoPromedioAnual(saldosMensuales: number[]): number {
  if (saldosMensuales.length === 0) return 0;
  const suma = saldosMensuales.reduce((a, b) => a + b, 0);
  return suma / saldosMensuales.length;
}

export interface FactorAjuste {
  factor: number | null;
  /** INPC del último mes del ejercicio. */
  inpcFinal: number | null;
  /** INPC del mes inmediato anterior al primer mes del ejercicio. */
  inpcBase: number | null;
  mesFinal: { year: number; month: number };
  mesBase: { year: number; month: number };
}

/**
 * Factor de ajuste anual (Art. 44, último párrafo).
 *
 * La ley da dos redacciones —ejercicio de 12 meses vs. menor a 12— pero para un
 * ejercicio regular AMBAS apuntan al mismo mes: el último del ejercicio
 * anterior ES el inmediato anterior a enero. Por eso una sola fórmula sirve
 * para los dos casos, y el ejercicio irregular queda cubierto sin caso aparte.
 */
export function factorAjusteAnual(year: number, primerMes = 1, ultimoMes = 12): FactorAjuste {
  const mesFinal = { year, month: ultimoMes };
  const mesBase = primerMes === 1 ? { year: year - 1, month: 12 } : { year, month: primerMes - 1 };
  const inpcFinal = inpc(mesFinal.year, mesFinal.month);
  const inpcBase = inpc(mesBase.year, mesBase.month);
  const factor = inpcFinal != null && inpcBase != null && inpcBase !== 0 ? inpcFinal / inpcBase - 1 : null;
  return { factor, inpcFinal, inpcBase, mesFinal, mesBase };
}

export interface CuentaSaldos {
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  /**
   * Saldo al último día de cada mes del ejercicio, en orden y con el signo
   * natural de la cuenta (positivo = saldo normal). Un elemento por mes.
   */
  saldosMensuales: number[];
}

export interface CuentaAjuste extends CuentaSaldos {
  clave: string;
  clase: ClaseAjuste;
  fundamento: string;
  revisar: boolean;
  /** true si la clase vino de un override del contador, no del defecto. */
  sobreescrita: boolean;
  promedio: number;
}

export interface EntradaAjuste {
  year: number;
  cuentas: CuentaSaldos[];
  primerMes?: number;
  ultimoMes?: number;
  /** Clasificación manual por clave de cuenta; pisa el defecto. */
  overrides?: Record<string, ClaseAjuste>;
  /** Meses del ejercicio sin postear: el promedio saldría incompleto. */
  mesesSinPostear?: number[];
  /**
   * Factor ya determinado. Sólo para cotejar ejemplos de la ley con el INPC
   * que traía el año del ejemplo; en producción se deriva del INPC cargado.
   */
  factorAjuste?: FactorAjuste;
}

export interface ResultadoAjuste {
  year: number;
  mesesEjercicio: number;
  factorAjuste: FactorAjuste;
  promedioCreditos: number;
  promedioDeudas: number;
  /** Diferencia en valor absoluto entre los dos promedios. */
  diferencia: number;
  acumulable: number;
  deducible: number;
  cuentas: CuentaAjuste[];
  advertencias: string[];
  /** false cuando falta INPC: sin factor no hay cifra que proponer. */
  calculable: boolean;
}

/**
 * Cálculo completo del ajuste anual por inflación.
 *
 * Devuelve SIEMPRE el detalle por cuenta —aunque falte el INPC— para que el
 * panel muestre en qué se apoya la cifra y no un número sin origen.
 */
export function calcularAjusteInflacion(entrada: EntradaAjuste): ResultadoAjuste {
  const primerMes = entrada.primerMes ?? 1;
  const ultimoMes = entrada.ultimoMes ?? 12;
  const mesesEjercicio = Math.max(0, ultimoMes - primerMes + 1);
  const overrides = entrada.overrides ?? {};

  // Cuentas de AGRUPACIÓN con hijas: su saldo ya viene sumado en las
  // subcuentas. Si se cuentan las dos, cada peso entra DOS veces — y como el
  // ajuste sale de la DIFERENCIA entre promedios, el error no se cancela: se
  // amplifica. Es la misma razón por la que el balance general se queda con
  // `nivel >= 3`. Sólo se excluye la madre cuando alguna hija trae saldo, para
  // no tirar una cuenta legítima que viva únicamente a nivel de grupo.
  const conSaldoPorGrupo = new Set(
    entrada.cuentas
      .filter((c) => c.subcuenta != null && c.saldosMensuales.some((s) => s !== 0))
      .map((c) => c.cuentaSAT)
  );

  const cuentas: CuentaAjuste[] = entrada.cuentas.map((c) => {
    const clave = claveCuenta(c.cuentaSAT, c.subcuenta);
    const regla = clasificacionPorDefecto(c.cuentaSAT, c.subcuenta);
    const esAgrupacion = c.subcuenta == null && conSaldoPorGrupo.has(c.cuentaSAT);
    const override = overrides[clave];
    const claseBase = esAgrupacion ? "EXCLUIDA" : regla.clase;
    return {
      ...c,
      clave,
      clase: override ?? claseBase,
      fundamento: esAgrupacion
        ? "Cuenta de agrupación: su saldo ya está contado en las subcuentas"
        : regla.fundamento,
      revisar: esAgrupacion ? false : regla.revisar,
      sobreescrita: override != null && override !== claseBase,
      promedio: saldoPromedioAnual(c.saldosMensuales),
    };
  });

  const sumaPromedios = (clase: ClaseAjuste) =>
    cuentas.filter((c) => c.clase === clase).reduce((a, c) => a + c.promedio, 0);

  const promedioCreditos = sumaPromedios("CREDITO");
  const promedioDeudas = sumaPromedios("DEUDA");
  const diferencia = Math.abs(promedioDeudas - promedioCreditos);
  const factor = entrada.factorAjuste ?? factorAjusteAnual(entrada.year, primerMes, ultimoMes);

  const advertencias: string[] = [];
  if (factor.factor == null) {
    advertencias.push(
      `Falta el INPC de ${factor.inpcFinal == null ? `${factor.mesFinal.year}-${String(factor.mesFinal.month).padStart(2, "0")}` : `${factor.mesBase.year}-${String(factor.mesBase.month).padStart(2, "0")}`}: sin él no se puede determinar el factor de ajuste (Art. 44 LISR).`
    );
  }
  if (entrada.mesesSinPostear?.length) {
    advertencias.push(
      `Meses sin contabilizar (${entrada.mesesSinPostear.join(", ")}): el saldo promedio anual del Art. 44 frac. I necesita los 12 cierres mensuales, así que la cifra saldría incompleta.`
    );
  }
  const porRevisar = cuentas.filter((c) => c.revisar && c.clase !== "EXCLUIDA" && c.promedio !== 0);
  if (porRevisar.length > 0) {
    advertencias.push(
      `${porRevisar.length} cuenta(s) dependen de hechos fuera del catálogo (Arts. 45 fracs. II y III, 46): confirma su clasificación antes de usar la cifra.`
    );
  }
  const negativas = cuentas.filter(
    (c) => c.clase !== "EXCLUIDA" && c.saldosMensuales.some((s) => s < 0)
  );
  if (negativas.length > 0) {
    advertencias.push(
      `${negativas.length} cuenta(s) incluidas tienen algún mes con saldo contrario a su naturaleza; revisa que no sea un error de captura antes de promediar.`
    );
  }

  const calculable = factor.factor != null;
  const monto = calculable ? diferencia * (factor.factor as number) : 0;

  return {
    year: entrada.year,
    mesesEjercicio,
    factorAjuste: factor,
    promedioCreditos,
    promedioDeudas,
    diferencia,
    // Art. 44 frac. II: deudas > créditos → acumulable.
    acumulable: promedioDeudas > promedioCreditos ? monto : 0,
    // Art. 44 frac. III: créditos > deudas → deducible.
    deducible: promedioCreditos > promedioDeudas ? monto : 0,
    cuentas,
    advertencias,
    calculable,
  };
}
