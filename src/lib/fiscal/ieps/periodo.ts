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

import { leerInciso, tasaTexto, type LecturaInciso } from "./incisos";

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
  /**
   * La CLASE del Art. 4º fr. IV — el impuesto acreditable y el impuesto a
   * cargo tienen que ser del mismo inciso. Cuando el inciso se identifica sin
   * ambigüedad se usa su clave; si no, la propia tasa, que nunca acredita.
   */
  clase: string;
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
    let fila = porTasa.get(clave);
    if (!fila) {
      const inciso = leerInciso(r.tasa);
      fila = {
        tasa: r.tasa,
        inciso,
        clase: inciso.certeza === "unico" ? inciso.candidatos[0].clave : `tasa:${clave}`,
        trasladado: 0,
        pagado: 0,
        renglones: 0,
      };
    }

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

export interface AcreditamientoClase {
  /** El inciso (o la tasa, si no se pudo identificar) que agrupa esta clase. */
  clase: string;
  etiqueta: string;
  causado: number;
  pagado: number;
  /** Lo que se resta de ESTA clase. Nunca más que lo causado en ella. */
  acreditado: number;
  /** El sobrante: sólo se compensa contra IEPS de la misma clase (Art. 5º). */
  saldoFavor: number;
}

export interface ResultadoIeps {
  /** Lo que se enteraría. **null** = falta la decisión del Art. 4º para saberlo. */
  monto: number | null;
  /** Cuánto se restó del trasladado, sumando todas las clases. */
  acreditado: number;
  /**
   * IEPS acreditable que sobró en su clase. NO se resta de otra: el Art. 4º
   * fr. IV exige misma clase y el saldo a favor del Art. 5º también.
   */
  saldoFavor: number;
  /** El detalle por clase, que es como realmente se determina el impuesto. */
  porClase: AcreditamientoClase[];
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
 *
 * EL ACREDITAMIENTO ES POR CLASE, no una resta global. El Art. 4º fr. IV exige
 * que el impuesto acreditable y el impuesto a cargo sean «bienes de la misma
 * clase», entendiendo por tales los agrupados en cada inciso del Art. 2º fr. I.
 * Restar el IEPS de plaguicidas contra el de alimentos daría un pago menor al
 * debido. Lo que sobra en su clase no se pasa a otra: queda como saldo a favor
 * de ESA clase (Art. 5º).
 *
 * Salvedad que no podemos ver: el Art. 4º fr. IV separa además la cerveza y las
 * bebidas refrescantes del resto de las bebidas con contenido alcohólico. El
 * CFDI no distingue una de otra dentro del inciso A), así que ahí la clase es
 * más ancha de lo que dice la ley.
 */
export function aPagarIeps(p: PeriodoIeps, decision: DecisionAcreditamiento): ResultadoIeps {
  const vacio = { acreditado: 0, saldoFavor: 0, porClase: [] as AcreditamientoClase[] };

  if (p.pagado === 0) {
    // No hay nada que acreditar: la decisión no cambia el número.
    return {
      ...vacio,
      monto: p.trasladado,
      completo: true,
      motivo: "Sin IEPS pagado a proveedores este mes: no hay nada que acreditar.",
    };
  }

  if (decision === "sin_decidir") {
    return {
      ...vacio,
      monto: null,
      completo: false,
      motivo:
        "Falta decidir si esta empresa acredita el IEPS que le trasladan (Art. 4º LIEPS). " +
        "El acreditamiento sólo procede para ciertos incisos y para quien causa el mismo impuesto.",
    };
  }

  if (decision === "no_acredita") {
    return {
      ...vacio,
      monto: r2(p.trasladado),
      completo: true,
      motivo: "Sin acreditamiento (Art. 4º LIEPS): se entera todo el IEPS trasladado.",
    };
  }

  // Acredita: clase por clase, cada una contra lo suyo.
  const clases = new Map<string, AcreditamientoClase>();
  for (const f of p.porTasa) {
    if (f.inciso.acreditablePorInciso !== true) {
      // No acreditable, o no se sabe: la clase existe sólo por lo causado.
      if (f.trasladado === 0) continue;
    }
    const acr =
      f.inciso.acreditablePorInciso === true ? Math.min(f.pagado, f.trasladado) : 0;
    const previa = clases.get(f.clase);
    const fila: AcreditamientoClase = previa ?? {
      clase: f.clase,
      etiqueta: f.inciso.certeza === "unico" ? f.inciso.etiqueta : `Tasa ${tasaTexto(f.tasa)}`,
      causado: 0,
      pagado: 0,
      acreditado: 0,
      saldoFavor: 0,
    };
    fila.causado += f.trasladado;
    fila.pagado += f.pagado;
    fila.acreditado += acr;
    if (f.inciso.acreditablePorInciso === true) fila.saldoFavor += f.pagado - acr;
    clases.set(f.clase, fila);
  }

  const porClase = [...clases.values()]
    .map((c) => ({
      ...c,
      causado: r2(c.causado),
      pagado: r2(c.pagado),
      acreditado: r2(c.acreditado),
      saldoFavor: r2(c.saldoFavor),
    }))
    .sort((a, b) => b.causado - a.causado || a.clase.localeCompare(b.clase));

  const acreditado = r2(porClase.reduce((s, c) => s + c.acreditado, 0));
  const saldoFavor = r2(porClase.reduce((s, c) => s + c.saldoFavor, 0));

  const partes = ["Se acredita por clase: cada inciso contra el impuesto que causó (Art. 4º fr. IV)."];
  if (p.pagadoNoAcreditable > 0) {
    partes.push(`${p.pagadoNoAcreditable.toFixed(2)} no es acreditable por su inciso y no se resta.`);
  }
  if (p.pagadoSinClasificar > 0) {
    partes.push(
      `${p.pagadoSinClasificar.toFixed(2)} no se pudo clasificar por su tasa: el monto está incompleto.`,
    );
  }
  if (saldoFavor > 0) {
    partes.push(`${saldoFavor.toFixed(2)} queda como saldo a favor de su propia clase, no se resta de otra.`);
  }

  return {
    monto: r2(p.trasladado - acreditado),
    acreditado,
    saldoFavor,
    porClase,
    completo: p.pagadoSinClasificar === 0,
    motivo: partes.join(" "),
  };
}
