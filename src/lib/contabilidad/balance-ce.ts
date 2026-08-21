// ─────────────────────────────────────────────────────────────────────────────
// Balance general con la balanza PRESENTADA como columna vertebral, y lo
// derivado de los CFDIs al lado — el gemelo del estado-resultados-ce.
//
// La diferencia con el estado de resultados NO es cosmética:
//
//   · El estado de resultados es FLUJO — lo que pasó en el período. Por eso
//     suma debe/haber del mes y deja fuera APERTURA y CIERRE.
//   · El balance es FOTO — lo que se tiene y se debe AL CIERRE del mes. Vive
//     de SALDOS acumulados, y la apertura no sólo cuenta: es el punto de
//     partida. Dejarla fuera daría un balance que arranca en cero cada enero.
//
// Convención de signo: la balanza CE trae el LADO en el signo (las cuentas
// acreedoras vienen negativas). Verificado en MARGOM 2025-12: activo
// +$485,326,593.01, pasivo −$453,437,766.68, capital −$18,992,047.44, y la
// suma de TODAS las hojas da $0.06 — el checksum de la propia balanza. Aquí se
// trabaja en esa convención y se ENTREGA en signo natural (un pasivo normal
// sale positivo), porque un balance que pinta «Proveedores −$5,815,719,699.32»
// no le dice nada a nadie.
//
// El resultado del ejercicio es −Σ saldoFin(4xxx–9xxx): las cuentas de
// resultado aún no traspasadas a capital. Sin ese renglón la ecuación no
// cuadra antes del cierre anual.
// ─────────────────────────────────────────────────────────────────────────────

export type ClaveGrupoBalance = "activo" | "pasivo" | "capital";

export interface RenglonBalance {
  numCta: string;
  nombre: string;
  /** Signo natural: un saldo normal sale positivo. */
  declarado: number;
  derivado: number;
  diferencia: number;
}

export interface GrupoBalance {
  clave: ClaveGrupoBalance;
  titulo: string;
  declarado: number;
  derivado: number;
  diferencia: number;
  cuentas: RenglonBalance[];
}

export interface BalanceCe {
  /** false cuando el período aún no se presenta: sólo hay derivado. */
  presentado: boolean;
  grupos: GrupoBalance[];
  /** Resultado del ejercicio aún no traspasado a capital. */
  resultado: { declarado: number; derivado: number; diferencia: number };
  totales: {
    activo: { declarado: number; derivado: number };
    /** Pasivo + capital + resultado: el otro lado de la ecuación. */
    pasivoCapitalResultado: { declarado: number; derivado: number };
    /** Activo − (pasivo + capital + resultado). Cero = la foto cuadra. */
    descuadre: { declarado: number; derivado: number };
  };
}

/** Saldo de UNA cuenta al cierre del mes, con el lado en el signo. */
export interface SaldoCuenta {
  numCta: string;
  nombre?: string | null;
  /** saldoFin en convención CE: deudoras +, acreedoras −. */
  saldo: number;
}

const GRUPOS: { clave: ClaveGrupoBalance; titulo: string; digito: string }[] = [
  { clave: "activo", titulo: "Activo", digito: "1" },
  { clave: "pasivo", titulo: "Pasivo", digito: "2" },
  { clave: "capital", titulo: "Capital contable", digito: "3" },
];

/**
 * El grupo de una cuenta por su primer dígito. 4–9 son cuentas de RESULTADO:
 * no forman un grupo del balance, se pliegan al resultado del ejercicio.
 */
export function grupoDeCuenta(numCta: string): ClaveGrupoBalance | "resultado" | null {
  const d = numCta.trim().charAt(0);
  const g = GRUPOS.find((x) => x.digito === d);
  if (g) return g.clave;
  return d >= "4" && d <= "9" ? "resultado" : null;
}

/**
 * Pasa un saldo en signo NATURAL (el que entrega la balanza derivada, donde un
 * pasivo normal ya llega positivo) a la convención CE del lado en el signo.
 * Es la única traducción entre los dos mundos; vive aquí para poder probarla.
 */
export function aLadoEnSigno(saldoNatural: number, tipo: string): number {
  const acreedora = tipo === "PASIVO" || tipo === "CAPITAL" || tipo === "INGRESO";
  return acreedora ? -saldoNatural : saldoNatural;
}

const c2 = (n: number) => Math.round(n * 100) / 100;
/** De la convención CE al signo natural del grupo. */
const aNatural = (saldo: number, clave: ClaveGrupoBalance) =>
  clave === "activo" ? saldo : -saldo;

/**
 * Arma el balance con los dos lados ya sumados por cuenta y en convención CE.
 * Una cuenta que exista de UN solo lado aparece igual, con cero en el otro —
 * es justo el renglón que hay que ver.
 */
export function construirBalance(
  declarado: SaldoCuenta[],
  derivado: SaldoCuenta[],
  opts: { presentado: boolean },
): BalanceCe {
  const porCuenta = new Map<string, { nombre: string; declarado: number; derivado: number }>();
  const acumula = (lista: SaldoCuenta[], lado: "declarado" | "derivado") => {
    for (const s of lista) {
      if (!grupoDeCuenta(s.numCta)) continue;
      const prev = porCuenta.get(s.numCta) ?? { nombre: s.nombre ?? "", declarado: 0, derivado: 0 };
      prev[lado] += s.saldo;
      if (!prev.nombre && s.nombre) prev.nombre = s.nombre;
      porCuenta.set(s.numCta, prev);
    }
  };
  acumula(declarado, "declarado");
  acumula(derivado, "derivado");

  const grupos: GrupoBalance[] = GRUPOS.map((g) => ({
    clave: g.clave,
    titulo: g.titulo,
    declarado: 0,
    derivado: 0,
    diferencia: 0,
    cuentas: [],
  }));
  const porClave = new Map(grupos.map((g) => [g.clave, g]));

  // El resultado se acumula en convención CE y se voltea al final.
  let resDeclarado = 0;
  let resDerivado = 0;

  for (const [numCta, v] of porCuenta) {
    const clave = grupoDeCuenta(numCta)!;
    if (clave === "resultado") {
      resDeclarado += v.declarado;
      resDerivado += v.derivado;
      continue;
    }
    // Una cuenta sin saldo de ningún lado no es un renglón del balance.
    if (Math.abs(v.declarado) < 0.005 && Math.abs(v.derivado) < 0.005) continue;
    const grupo = porClave.get(clave)!;
    const dec = aNatural(v.declarado, clave);
    const der = aNatural(v.derivado, clave);
    grupo.cuentas.push({
      numCta,
      nombre: v.nombre,
      declarado: c2(dec),
      derivado: c2(der),
      diferencia: c2(der - dec),
    });
    grupo.declarado += dec;
    grupo.derivado += der;
  }

  for (const g of grupos) {
    g.declarado = c2(g.declarado);
    g.derivado = c2(g.derivado);
    g.diferencia = c2(g.derivado - g.declarado);
    // El renglón más grande primero: es donde vive la explicación.
    g.cuentas.sort(
      (a, b) => Math.abs(b.declarado || b.derivado) - Math.abs(a.declarado || a.derivado),
    );
  }

  const resultado = {
    declarado: c2(-resDeclarado),
    derivado: c2(-resDerivado),
    diferencia: c2(-resDerivado - -resDeclarado),
  };

  const de = (clave: ClaveGrupoBalance, lado: "declarado" | "derivado") =>
    porClave.get(clave)![lado];
  const otroLado = (lado: "declarado" | "derivado") =>
    c2(de("pasivo", lado) + de("capital", lado) + resultado[lado]);

  const activo = { declarado: de("activo", "declarado"), derivado: de("activo", "derivado") };
  const pcr = { declarado: otroLado("declarado"), derivado: otroLado("derivado") };

  return {
    presentado: opts.presentado,
    // Un grupo vacío no se pinta, pero el activo SIEMPRE va: un balance sin
    // activo no es un balance con menos renglones, es un dato que falta.
    grupos: grupos.filter((g) => g.cuentas.length > 0 || g.clave === "activo"),
    resultado,
    totales: {
      activo,
      pasivoCapitalResultado: pcr,
      descuadre: {
        declarado: c2(activo.declarado - pcr.declarado),
        derivado: c2(activo.derivado - pcr.derivado),
      },
    },
  };
}
