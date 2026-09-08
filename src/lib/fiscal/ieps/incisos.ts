// ─────────────────────────────────────────────────────────────────────────────
// Los incisos del Art. 2º LIEPS, y cuáles se pueden ACREDITAR (Art. 4º).
//
// Por qué esto existe y no basta con la tasa: el acreditamiento del IEPS NO es
// general como el del IVA. El Art. 4º lo limita a ciertos incisos, y además
// exige que el contribuyente sea causante del MISMO bien. Un comerciante que
// revende chocolate paga IEPS a su proveedor y NO puede restarlo; un productor
// de bebidas sí. La diferencia son decenas de miles de pesos al año.
//
// Para poder siquiera plantear la pregunta hay que saber de qué inciso viene el
// impuesto — y el CFDI no lo dice: sólo trae la tasa. Este catálogo hace el
// camino inverso (tasa → incisos candidatos) y ES HONESTO SOBRE LA AMBIGÜEDAD:
// el 30 % puede ser bebida alcohólica de más de 14° GL (2-I-A) o juegos con
// apuestas (2-II-B), y esos dos NO se tratan igual. Cuando hay más de un
// candidato la respuesta viaja marcada `ambigua` y la pantalla lo dice en vez
// de elegir por su cuenta.
//
// `verificado: false` en todo el catálogo: las tasas están tomadas del texto
// vigente pero NO se han cotejado contra el DOF por el mismo proceso que las
// del ISN. Va a un PR revisado, no a un dato escrito en silencio.
// ─────────────────────────────────────────────────────────────────────────────

export interface IncisoIeps {
  /** "2-I-A", "2-II-B"… tal como se cita. */
  clave: string;
  concepto: string;
  /** Tasa ad valorem del inciso. null = se cobra por CUOTA, no por tasa. */
  tasa: number | null;
  /**
   * ¿El Art. 4º admite acreditar el impuesto trasladado por este inciso?
   * Sólo A), D), F), G), I) y J) de la fracción I — y aun así el Art. 4º pide
   * que quien acredita sea contribuyente del mismo bien. Esto dice si el inciso
   * ENTRA en la lista, no si esta empresa en particular puede.
   */
  acreditablePorInciso: boolean;
}

/** El catálogo, en el orden del artículo. */
export const INCISOS_IEPS: IncisoIeps[] = [
  { clave: "2-I-A", concepto: "Cerveza y bebidas con hasta 14° GL", tasa: 0.265, acreditablePorInciso: true },
  { clave: "2-I-A", concepto: "Bebidas alcohólicas de más de 14° y hasta 20° GL", tasa: 0.3, acreditablePorInciso: true },
  { clave: "2-I-A", concepto: "Bebidas alcohólicas de más de 20° GL", tasa: 0.53, acreditablePorInciso: true },
  { clave: "2-I-B", concepto: "Alcohol, alcohol desnaturalizado y mieles incristalizables", tasa: 0.5, acreditablePorInciso: false },
  { clave: "2-I-C", concepto: "Cigarros y tabacos labrados", tasa: 1.6, acreditablePorInciso: false },
  { clave: "2-I-C", concepto: "Puros y tabacos labrados hechos enteramente a mano", tasa: 0.304, acreditablePorInciso: false },
  { clave: "2-I-D", concepto: "Combustibles automotrices (cuota por litro)", tasa: null, acreditablePorInciso: true },
  { clave: "2-I-F", concepto: "Bebidas energetizantes", tasa: 0.25, acreditablePorInciso: true },
  { clave: "2-I-G", concepto: "Bebidas saborizadas (cuota por litro)", tasa: null, acreditablePorInciso: true },
  { clave: "2-I-H", concepto: "Combustibles fósiles (cuota)", tasa: null, acreditablePorInciso: false },
  { clave: "2-I-I", concepto: "Plaguicidas categoría 1 y 2 de toxicidad", tasa: 0.09, acreditablePorInciso: true },
  { clave: "2-I-I", concepto: "Plaguicidas categoría 3 de toxicidad", tasa: 0.07, acreditablePorInciso: true },
  { clave: "2-I-I", concepto: "Plaguicidas categoría 4 de toxicidad", tasa: 0.06, acreditablePorInciso: true },
  { clave: "2-I-J", concepto: "Alimentos no básicos de alta densidad calórica (≥ 275 kcal/100 g)", tasa: 0.08, acreditablePorInciso: true },
  { clave: "2-II-B", concepto: "Juegos con apuestas y sorteos", tasa: 0.3, acreditablePorInciso: false },
];

export interface LecturaInciso {
  /** Los incisos cuya tasa coincide. Vacío = tasa que el catálogo no reconoce. */
  candidatos: IncisoIeps[];
  /** Cómo leer `candidatos`: uno solo, varios, o ninguno. */
  certeza: "unico" | "ambiguo" | "desconocido";
  /** Etiqueta corta para la pantalla. Nunca inventa un concepto que no consta. */
  etiqueta: string;
  /**
   * ¿El Art. 4º admite acreditarlo? null cuando la tasa es ambigua y los
   * candidatos NO coinciden entre sí — ahí la respuesta depende de cuál sea, y
   * decirla sería adivinar.
   */
  acreditablePorInciso: boolean | null;
}

/** Redondeo de tasa a 4 decimales: el CFDI trae 0.080000 y el catálogo 0.08. */
const t4 = (n: number) => Math.round(n * 10000) / 10000;

/** De la tasa del CFDI a los incisos que pueden haberla causado. */
export function leerInciso(tasa: number | null): LecturaInciso {
  if (tasa === null) {
    return { candidatos: [], certeza: "desconocido", etiqueta: "Cuota fija o tasa no expresada", acreditablePorInciso: null };
  }
  const candidatos = INCISOS_IEPS.filter((i) => i.tasa !== null && t4(i.tasa) === t4(tasa));
  if (candidatos.length === 0) {
    return { candidatos: [], certeza: "desconocido", etiqueta: `Tasa ${(tasa * 100).toFixed(2).replace(/\.?0+$/, "")} % sin inciso en el catálogo`, acreditablePorInciso: null };
  }
  if (candidatos.length === 1) {
    return {
      candidatos,
      certeza: "unico",
      etiqueta: `${candidatos[0].concepto} (Art. ${candidatos[0].clave})`,
      acreditablePorInciso: candidatos[0].acreditablePorInciso,
    };
  }
  const todosIgual = candidatos.every((c) => c.acreditablePorInciso === candidatos[0].acreditablePorInciso);
  return {
    candidatos,
    certeza: "ambiguo",
    etiqueta: candidatos.map((c) => `${c.concepto} (Art. ${c.clave})`).join(" o "),
    acreditablePorInciso: todosIgual ? candidatos[0].acreditablePorInciso : null,
  };
}
