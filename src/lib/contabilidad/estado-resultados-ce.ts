/**
 * El estado de resultados con la CE como columna vertebral.
 *
 * La tesis del producto invertida en una pantalla: el número que manda es el
 * DECLARADO —el que ya está presentado al SAT, el que reconoce un banco, un
 * comprador o el propio dueño— y lo derivado de los CFDIs va debajo, como
 * evidencia, no como competencia. Discutirle su cifra al contador es una
 * pelea; enseñarle qué documentos la sostienen es una herramienta.
 *
 * Tres columnas por renglón: declarado, derivado, diferencia. La diferencia se
 * muestra siempre. Cuando era de $1,600M esconderla habría sido lo prudente;
 * hoy es del orden del 1% y enseñarla es el argumento.
 *
 * Dos modos, porque la CE llega tarde por definición:
 *   • Período PRESENTADO → declarado manda, derivado es la evidencia.
 *   • Período aún sin presentar → no hay declarado; el derivado se marca
 *     PRELIMINAR. Es la parte más útil: dice dónde va a cerrar el mes antes de
 *     que el contador lo cierre.
 *
 * Convención de signo: todo renglón aporta al resultado con su signo natural
 * (haber − debe). Ingresos suman, costos y gastos restan. Así el resultado es
 * la suma de la columna, sin casos especiales por rubro.
 */
export type ClaveRubro = "ingresos" | "costos" | "gastos" | "financieros" | "otros";

export interface RenglonCuenta {
  numCta: string;
  nombre: string;
  declarado: number;
  derivado: number;
  diferencia: number;
}

export interface Rubro {
  clave: ClaveRubro;
  titulo: string;
  declarado: number;
  derivado: number;
  diferencia: number;
  cuentas: RenglonCuenta[];
}

export interface EstadoResultadosCe {
  /** false cuando el período aún no se presenta: sólo hay derivado. */
  presentado: boolean;
  rubros: Rubro[];
  utilidadBruta: { declarado: number; derivado: number };
  resultado: { declarado: number; derivado: number; diferencia: number };
}

const RUBROS: { clave: ClaveRubro; titulo: string; digito: string }[] = [
  { clave: "ingresos", titulo: "Ingresos", digito: "4" },
  { clave: "costos", titulo: "Costo de ventas", digito: "5" },
  { clave: "gastos", titulo: "Gastos de operación", digito: "6" },
  { clave: "financieros", titulo: "Resultado integral de financiamiento", digito: "7" },
  { clave: "otros", titulo: "Otros", digito: "8" },
];

export function rubroDeCuenta(numCta: string): ClaveRubro | null {
  const d = numCta.trim().charAt(0);
  return RUBROS.find((r) => r.digito === d)?.clave ?? null;
}

const c2 = (n: number) => Math.round(n * 100) / 100;

export interface MovimientoCuenta {
  numCta: string;
  nombre?: string | null;
  /** Aporte al resultado con signo: haber − debe. */
  monto: number;
}

/**
 * Arma el estado con las dos fuentes ya sumadas por cuenta. Una cuenta que
 * exista de UN solo lado aparece igual, con cero en el otro — es justo el
 * renglón que hay que ver (lo que él declara y nosotros no derivamos, o al
 * revés).
 */
export function construirEstadoResultados(
  declarado: MovimientoCuenta[],
  derivado: MovimientoCuenta[],
  opts: { presentado: boolean },
): EstadoResultadosCe {
  const porCuenta = new Map<string, { nombre: string; declarado: number; derivado: number }>();
  const acumula = (lista: MovimientoCuenta[], lado: "declarado" | "derivado") => {
    for (const m of lista) {
      if (!rubroDeCuenta(m.numCta)) continue;
      const prev = porCuenta.get(m.numCta) ?? { nombre: m.nombre ?? "", declarado: 0, derivado: 0 };
      prev[lado] += m.monto;
      if (!prev.nombre && m.nombre) prev.nombre = m.nombre;
      porCuenta.set(m.numCta, prev);
    }
  };
  acumula(declarado, "declarado");
  acumula(derivado, "derivado");

  const rubros: Rubro[] = RUBROS.map((r) => ({
    clave: r.clave,
    titulo: r.titulo,
    declarado: 0,
    derivado: 0,
    diferencia: 0,
    cuentas: [],
  }));
  const porClave = new Map(rubros.map((r) => [r.clave, r]));

  for (const [numCta, v] of porCuenta) {
    const clave = rubroDeCuenta(numCta)!;
    const rubro = porClave.get(clave)!;
    if (Math.abs(v.declarado) < 0.005 && Math.abs(v.derivado) < 0.005) continue;
    rubro.cuentas.push({
      numCta,
      nombre: v.nombre,
      declarado: c2(v.declarado),
      derivado: c2(v.derivado),
      diferencia: c2(v.derivado - v.declarado),
    });
    rubro.declarado += v.declarado;
    rubro.derivado += v.derivado;
  }

  for (const r of rubros) {
    r.declarado = c2(r.declarado);
    r.derivado = c2(r.derivado);
    r.diferencia = c2(r.derivado - r.declarado);
    // El renglón más grande primero: es donde vive la explicación.
    r.cuentas.sort((a, b) => Math.abs(b.declarado || b.derivado) - Math.abs(a.declarado || a.derivado));
  }

  const de = (clave: ClaveRubro, lado: "declarado" | "derivado") => porClave.get(clave)![lado];
  const resDeclarado = c2(rubros.reduce((s, r) => s + r.declarado, 0));
  const resDerivado = c2(rubros.reduce((s, r) => s + r.derivado, 0));

  return {
    presentado: opts.presentado,
    rubros: rubros.filter((r) => r.cuentas.length > 0),
    utilidadBruta: {
      declarado: c2(de("ingresos", "declarado") + de("costos", "declarado")),
      derivado: c2(de("ingresos", "derivado") + de("costos", "derivado")),
    },
    resultado: { declarado: resDeclarado, derivado: resDerivado, diferencia: c2(resDerivado - resDeclarado) },
  };
}
