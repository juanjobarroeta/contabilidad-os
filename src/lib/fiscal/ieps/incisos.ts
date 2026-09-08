// ─────────────────────────────────────────────────────────────────────────────
// Los incisos del Art. 2º LIEPS, y cuáles se pueden ACREDITAR (Art. 4º).
//
// Por qué esto existe y no basta con la tasa: el acreditamiento del IEPS NO es
// general como el del IVA. El Art. 4º, segundo párrafo, lo limita a los incisos
// A), D), F), G), I) y J) DE LA FRACCIÓN I —bienes, nunca servicios— y su
// fracción I exige además ser contribuyente del mismo impuesto. Un comerciante
// que revende chocolate paga IEPS a su proveedor y NO puede restarlo; un
// productor de bebidas sí. La diferencia son decenas de miles de pesos al año.
//
// Para poder siquiera plantear la pregunta hay que saber de qué inciso viene el
// impuesto — y el CFDI no lo dice: sólo trae la tasa. Este catálogo hace el
// camino inverso (tasa → incisos candidatos) y ES HONESTO SOBRE LA AMBIGÜEDAD:
// tras la reforma DOF 07-11-2025 el 8 % puede ser alimentos no básicos (2-I-J,
// acreditable) o videojuegos violentos (2-II-D, servicio que no lo es), y el
// 50 % puede ser alcohol (2-I-B) o juegos con apuestas (2-II-B). Cuando los
// candidatos no coinciden en si el Art. 4º los admite, la respuesta viaja como
// «no se sabe» y ese importe NO se acredita ni se descarta: queda sin
// clasificar y el monto del mes sale marcado incompleto.
//
// COTEJADO el 2026-09-08 contra el texto de la Cámara de Diputados
// (LeyesBiblio/pdf/LIEPS.pdf, última reforma DOF 07-11-2025), artículos 2º y 4º.
// Ese cotejo corrigió cuatro errores que traía la primera versión de este
// catálogo, todos de la reforma de 2025: cigarros 160 % → 200 %, puros hechos a
// mano 30.4 % → 32 %, juegos con apuestas 30 % → 50 %, y faltaban «otros
// productos que contengan nicotina» (100 %), telecomunicaciones (3 %, que yo
// creía derogado) y videojuegos (8 %, nuevo). Las cuotas por unidad no se
// cargan aquí: el CFDI las trae en `factor: CUOTA` y se agrupan aparte.
// ─────────────────────────────────────────────────────────────────────────────

export interface IncisoIeps {
  /** "2-I-A", "2-II-B"… tal como se cita. */
  clave: string;
  concepto: string;
  /** I = enajenación/importación de bienes; II = prestación de servicios. */
  fraccion: "I" | "II";
  /** Tasa ad valorem. null = el inciso se cobra por CUOTA, no por tasa. */
  tasa: number | null;
  /**
   * ¿El Art. 4º, 2º párrafo, admite acreditar el impuesto TRASLADADO por este
   * inciso? Sólo A), D), F), G), I) y J) de la fracción I. Esto dice si el
   * inciso entra en la lista, no si ESTA empresa puede: eso lo decide el
   * contador (Art. 4º fr. I: hay que causar el mismo impuesto).
   */
  acreditablePorInciso: boolean;
}

/** El catálogo, en el orden del artículo. */
export const INCISOS_IEPS: IncisoIeps[] = [
  { clave: "2-I-A", concepto: "Cerveza y bebidas de hasta 14° G.L.", fraccion: "I", tasa: 0.265, acreditablePorInciso: true },
  { clave: "2-I-A", concepto: "Bebidas alcohólicas de más de 14° y hasta 20° G.L.", fraccion: "I", tasa: 0.3, acreditablePorInciso: true },
  { clave: "2-I-A", concepto: "Bebidas alcohólicas de más de 20° G.L.", fraccion: "I", tasa: 0.53, acreditablePorInciso: true },
  { clave: "2-I-B", concepto: "Alcohol, alcohol desnaturalizado y mieles incristalizables", fraccion: "I", tasa: 0.5, acreditablePorInciso: false },
  { clave: "2-I-C", concepto: "Cigarros, puros y otros tabacos labrados", fraccion: "I", tasa: 2.0, acreditablePorInciso: false },
  { clave: "2-I-C", concepto: "Otros productos que contengan nicotina", fraccion: "I", tasa: 1.0, acreditablePorInciso: false },
  { clave: "2-I-C", concepto: "Puros y otros tabacos labrados hechos enteramente a mano", fraccion: "I", tasa: 0.32, acreditablePorInciso: false },
  { clave: "2-I-D", concepto: "Combustibles automotrices (cuota por litro)", fraccion: "I", tasa: null, acreditablePorInciso: true },
  { clave: "2-I-F", concepto: "Bebidas energetizantes", fraccion: "I", tasa: 0.25, acreditablePorInciso: true },
  { clave: "2-I-G", concepto: "Bebidas saborizadas (cuota por litro)", fraccion: "I", tasa: null, acreditablePorInciso: true },
  { clave: "2-I-H", concepto: "Combustibles fósiles (cuota)", fraccion: "I", tasa: null, acreditablePorInciso: false },
  { clave: "2-I-I", concepto: "Plaguicidas categorías 1 y 2 de toxicidad", fraccion: "I", tasa: 0.09, acreditablePorInciso: true },
  { clave: "2-I-I", concepto: "Plaguicidas categoría 3 de toxicidad", fraccion: "I", tasa: 0.07, acreditablePorInciso: true },
  { clave: "2-I-I", concepto: "Plaguicidas categoría 4 de toxicidad", fraccion: "I", tasa: 0.06, acreditablePorInciso: true },
  { clave: "2-I-J", concepto: "Alimentos no básicos de alta densidad calórica (≥ 275 kcal/100 g)", fraccion: "I", tasa: 0.08, acreditablePorInciso: true },
  // Fracción II — SERVICIOS. Ninguno es acreditable: el Art. 4º, 2º párrafo,
  // sólo lista incisos de la fracción I.
  { clave: "2-II-B", concepto: "Juegos con apuestas y sorteos", fraccion: "II", tasa: 0.5, acreditablePorInciso: false },
  { clave: "2-II-C", concepto: "Servicios por redes públicas de telecomunicaciones", fraccion: "II", tasa: 0.03, acreditablePorInciso: false },
  { clave: "2-II-D", concepto: "Acceso o descarga de videojuegos con contenido violento o para adultos", fraccion: "II", tasa: 0.08, acreditablePorInciso: false },
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

/** Formato corto de una tasa: 0.265 → «26.5 %». */
export function tasaTexto(tasa: number | null): string {
  return tasa === null ? "cuota" : `${(tasa * 100).toFixed(2).replace(/\.?0+$/, "")} %`;
}

/** De la tasa del CFDI a los incisos que pueden haberla causado. */
export function leerInciso(tasa: number | null): LecturaInciso {
  if (tasa === null) {
    return {
      candidatos: [],
      certeza: "desconocido",
      etiqueta: "Cuota por unidad; el inciso no se puede leer de la tasa",
      acreditablePorInciso: null,
    };
  }
  const candidatos = INCISOS_IEPS.filter((i) => i.tasa !== null && t4(i.tasa) === t4(tasa));
  if (candidatos.length === 0) {
    return {
      candidatos: [],
      certeza: "desconocido",
      etiqueta: `Tasa ${tasaTexto(tasa)} sin inciso en el catálogo`,
      acreditablePorInciso: null,
    };
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
