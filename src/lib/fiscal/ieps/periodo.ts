// ─────────────────────────────────────────────────────────────────────────────
// El IEPS del periodo — un impuesto que la app veía y no declaraba.
//
// Hasta aquí el IEPS existía en dos mitades que no se hablaban: la columna
// `iepsPagar` de TaxDeclaration, que sólo se llenaba copiando el acuse del SAT,
// y `salameria/ieps.ts`, que sumaba los CFDIs de UNA empresa en su hub. El
// motor mensual (`computeTaxPosition`) calcula IVA e ISR y no lo toca. Para un
// distribuidor de abarrote son ~$305 mil al año en 380 renglones: enseñar
// «Total al SAT» sin ese impuesto no es un hueco de detalle, es una cifra falsa.
//
// LO QUE SÍ HACE: leer lo que los comprobantes YA dicen. El IEPS trasladado y
// el pagado salen de `InvoiceTax`, no de una inferencia sobre el giro. Si la
// empresa no traslada IEPS en ningún CFDI, aquí no hay obligación que enseñar
// — la evidencia manda, no la CSF.
//
// LAS DOS COSAS QUE NO HACE, A PROPÓSITO:
//
// 1. NO ACREDITA SOLO. El Art. 4º LIEPS limita el acreditamiento por inciso Y
//    exige ser contribuyente del mismo bien: un comerciante que revende
//    chocolate paga IEPS a su proveedor y NO lo resta. La app no puede saber
//    cuál es el caso, así que `aPagarIeps` devuelve **null** mientras nadie lo
//    haya decidido y haya algo que decidir. Un total que se inventa la decisión
//    es peor que un total que dice qué le falta.
//
// 2. NO USA FLUJO. El IVA se determina cuando se cobra (Art. 1-B LIVA) y el
//    motor del mes lo hace así; esto suma por FECHA DE CFDI. Se marca
//    `baseFecha: "CFDI"` para que nadie confunda esta cifra con la declaración.
// ─────────────────────────────────────────────────────────────────────────────

import { leerInciso, type LecturaInciso } from "./incisos";

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Un renglón de impuesto IEPS de un CFDI, ya reducido a lo que importa. */
export interface RenglonIeps {
  importe: number;
  /** Tasa del renglón. null cuando el CFDI la trae por cuota o no la expresa. */
  tasa: number | null;
  /** true = es una RETENCIÓN de IEPS: se entera aparte, no es el impuesto del mes. */
  retencion: boolean;
  /** INGRESO = lo cobró ella; EGRESO = se lo cobraron. */
  sentido: "INGRESO" | "EGRESO";
}

export interface TasaIeps {
  tasa: number | null;
  /** De qué inciso del Art. 2º puede venir, y si eso es único o ambiguo. */
  inciso: LecturaInciso;
  trasladado: number;
  pagado: number;
  renglones: number;
}

/** La decisión del contador sobre el Art. 4º, para ESTA empresa. */
export type DecisionAcreditamiento = "acredita" | "no_acredita" | "sin_decidir";

export interface PeriodoIeps {
  /** "YYYY-MM". */
  periodo: string;
  /** IEPS que la empresa trasladó en sus CFDIs de ingreso. */
  trasladado: number;
  /** IEPS que sus proveedores le trasladaron. */
  pagado: number;
  /** Del pagado: lo que el Art. 4º SÍ admite por inciso. */
  pagadoAcreditable: number;
  /** Del pagado: lo que el Art. 4º NO admite. Nunca se resta, decida lo que decida. */
  pagadoNoAcreditable: number;
  /** Del pagado: tasas que el catálogo no reconoce o son ambiguas. Falta el dato. */
  pagadoSinClasificar: number;
  /** IEPS retenido en los CFDIs. Se entera por separado; no entra en el neto. */
  retenido: number;
  renglones: number;
  porTasa: TasaIeps[];
  /** ¿Hay obligación con evidencia? Trasladar IEPS es serlo; pagarlo no. */
  causa: boolean;
  /** Cómo se asignó al periodo. "CFDI" = por fecha del comprobante, no por flujo. */
  baseFecha: "CFDI";
}

/** Arma el IEPS del mes desde los renglones ya leídos. PURA. */
export function periodoIeps(year: number, month: number, renglones: RenglonIeps[]): PeriodoIeps {
  const porTasa = new Map<string, TasaIeps>();
  let trasladado = 0;
  let pagado = 0;
  let retenido = 0;
  let pagadoAcreditable = 0;
  let pagadoNoAcreditable = 0;
  let pagadoSinClasificar = 0;

  for (const r of renglones) {
    // Una retención de IEPS es impuesto de un TERCERO que aquí sólo se entera
    // (Art. 5º-A). Sumarla al traslado inflaría los dos lados del neto.
    if (r.retencion) {
      retenido += r.importe;
      continue;
    }

    const clave = r.tasa === null ? "cuota" : String(r.tasa);
    const fila = porTasa.get(clave) ?? {
      tasa: r.tasa,
      inciso: leerInciso(r.tasa),
      trasladado: 0,
      pagado: 0,
      renglones: 0,
    };

    if (r.sentido === "INGRESO") {
      trasladado += r.importe;
      fila.trasladado += r.importe;
    } else {
      pagado += r.importe;
      fila.pagado += r.importe;
      const admite = fila.inciso.acreditablePorInciso;
      if (admite === true) pagadoAcreditable += r.importe;
      else if (admite === false) pagadoNoAcreditable += r.importe;
      else pagadoSinClasificar += r.importe;
    }
    fila.renglones++;
    porTasa.set(clave, fila);
  }

  // Orden útil: primero lo grande, y las cuotas (tasa null) al final.
  const filas = [...porTasa.values()]
    .map((f) => ({ ...f, trasladado: r2(f.trasladado), pagado: r2(f.pagado) }))
    .sort((a, b) => (b.tasa ?? -1) - (a.tasa ?? -1));

  return {
    periodo: `${year}-${String(month).padStart(2, "0")}`,
    trasladado: r2(trasladado),
    pagado: r2(pagado),
    pagadoAcreditable: r2(pagadoAcreditable),
    pagadoNoAcreditable: r2(pagadoNoAcreditable),
    pagadoSinClasificar: r2(pagadoSinClasificar),
    retenido: r2(retenido),
    renglones: filas.reduce((a, f) => a + f.renglones, 0),
    porTasa: filas,
    causa: r2(trasladado) > 0,
    baseFecha: "CFDI",
  };
}

export interface ResultadoIeps {
  /** Lo que se enteraría. **null** = falta la decisión del Art. 4º para saberlo. */
  monto: number | null;
  /** Cuánto se restó del trasladado. 0 cuando no se acredita. */
  acreditado: number;
  /** false = el monto existe pero le falta una parte por clasificar. */
  completo: boolean;
  /** Por qué el monto es el que es (o por qué no hay monto). Va a la pantalla. */
  motivo: string;
}

/**
 * El IEPS a enterar del mes, DADA la decisión del contador sobre el Art. 4º.
 *
 * Devuelve `monto: null` cuando hay IEPS pagado a proveedores y nadie ha
 * decidido si esta empresa lo acredita: la diferencia entre acreditar y no
 * acreditar es todo el importe, y elegir por default sería inventar la cifra.
 */
export function aPagarIeps(p: PeriodoIeps, decision: DecisionAcreditamiento): ResultadoIeps {
  if (p.pagado === 0) {
    // No hay nada que acreditar: la decisión no cambia el número.
    return {
      monto: p.trasladado,
      acreditado: 0,
      completo: true,
      motivo: "Sin IEPS pagado a proveedores este mes: no hay nada que acreditar.",
    };
  }

  if (decision === "sin_decidir") {
    return {
      monto: null,
      acreditado: 0,
      completo: false,
      motivo:
        "Falta decidir si esta empresa acredita el IEPS que le trasladan (Art. 4º LIEPS). " +
        "El acreditamiento sólo procede para ciertos incisos y para quien es contribuyente del mismo bien.",
    };
  }

  if (decision === "no_acredita") {
    return {
      monto: r2(p.trasladado),
      acreditado: 0,
      completo: true,
      motivo: "Sin acreditamiento (Art. 4º LIEPS): se entera todo el IEPS trasladado.",
    };
  }

  const acreditado = r2(p.pagadoAcreditable);
  const partes: string[] = [`Se acredita el IEPS de los incisos que admite el Art. 4º.`];
  if (p.pagadoNoAcreditable > 0) {
    partes.push(`${p.pagadoNoAcreditable.toFixed(2)} no es acreditable por su inciso y no se resta.`);
  }
  if (p.pagadoSinClasificar > 0) {
    partes.push(
      `${p.pagadoSinClasificar.toFixed(2)} no se pudo clasificar por su tasa: el monto está incompleto.`,
    );
  }
  return {
    monto: r2(p.trasladado - acreditado),
    acreditado,
    completo: p.pagadoSinClasificar === 0,
    motivo: partes.join(" "),
  };
}
