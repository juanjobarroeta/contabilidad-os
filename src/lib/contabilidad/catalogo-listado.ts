// ─────────────────────────────────────────────────────────────────────────────
// Lee el «Listado de Cuentas» que exportan los sistemas contables y le pone a
// cada cuenta su código agrupador del Anexo 24. PURO.
//
// Es la Fase 1 del plan (docs/PLAN-motor-plan-propio.md) por la puerta de
// atrás: el motor ya sabe postear al plan PROPIO en cuanto ChartAccount.codAgrup
// existe, pero hasta ahora el único camino para poblarlo era importar el XML de
// Contabilidad Electrónica. Un despacho que todavía no presenta CE —o que nos
// pasa su catálogo en Excel— se quedaba fuera.
//
// EL LISTADO NO TRAE EL CÓDIGO AGRUPADOR, TRAE SU NOMBRE. Ahí está el trabajo:
// «Caja y efectivo» hay que volverlo 101.01. Y el nombre no siempre alcanza,
// porque el catálogo del SAT repite nombres entre el padre y su primer hijo
// («Inventario» es 115 y también 115.01) y entre partidas de corto y largo
// plazo («Otros instrumentos financieros» es 104, 190, 104.01 y 190.01).
//
// NO SE PUEDE DEDUCIR DEL NÚMERO DE CUENTA. Tentaba: sus códigos son de nueve
// dígitos en bloques de tres y el primero coincide con el mayor del SAT, así
// que parecía que 101001000 era 101.01. Medido contra los 2,340 renglones del
// hospital: los tres dígitos de en medio son SU numeración, no la del SAT. Sus
// cinco cajas —Tesorería, Admisiones, Cafetería, Farmacia Externa, General—
// son 101001000 a 101005000 y las cinco declaran «Caja y efectivo», o sea
// 101.01 las cinco. Deducirlo del número las habría mandado a 101.01…101.05, y
// 101.02 ni siquiera existe en el Anexo 24.
// ─────────────────────────────────────────────────────────────────────────────

import { CODIGO_AGRUPADOR_OFICIAL } from "./codigo-agrupador";
import { normalizar } from "./agrupador-candidatos";

export interface CuentaListado {
  /** El código propio de la empresa, tal cual viene. Es su identidad. */
  codigo: string;
  nombre: string;
  /** "D" deudora | "A" acreedora, de la columna Tipo. */
  naturaleza: "D" | "A";
  /** Cuenta de título/mayor: agrupa, no recibe movimientos. */
  esDeMayor: boolean;
  /** El NOMBRE del agrupador que declara la empresa (no el código). */
  agrupador: string;
  nivel: number;
}

/** Cómo se llegó al código — para poder auditar la importación. */
export type ViaAgrupador =
  | "nombre-unico"
  | "por-mayor"
  | "padre"
  | "hijo"
  | "sin-agrupador"
  | "nombre-desconocido"
  | "ambiguo";

export interface AgrupadorResuelto {
  codAgrup: string | null;
  via: ViaAgrupador;
  /** Cuando queda ambiguo, cuáles eran los candidatos. */
  candidatos?: string[];
}

/** nombre normalizado → códigos que lo llevan. Se arma una vez. */
const POR_NOMBRE: Map<string, string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const [codigo, nombre] of Object.entries(CODIGO_AGRUPADOR_OFICIAL)) {
    const k = normalizar(nombre);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(codigo);
  }
  return m;
})();

/**
 * El agrupador de una cuenta a partir de lo que el listado declara.
 *
 * Cuando el nombre no alcanza, desempatan dos señales del propio renglón:
 *
 *   1. SU MAYOR. Los catálogos se numeran sobre el del SAT en el primer bloque:
 *      la cuenta 109022000 dice «Derechos fiduciarios», que es 109.22, 203.17 y
 *      253.17 a la vez — pero empieza con 109. Esto es distinto de deducir el
 *      código del número: aquí el número sólo elige entre candidatos que el
 *      NOMBRE ya propuso.
 *   2. SI ES DE TÍTULO. Entre un padre y su primer hijo con el mismo nombre
 *      («Inventario» = 115 y 115.01), una cuenta de mayor es el padre y una de
 *      detalle es el hijo.
 *
 * Lo que sigue sin resolverse devuelve null a propósito: el motor cae al stub
 * de siempre y el contador decide con un override. Inventar un agrupador es
 * peor que no ponerlo — el SAT rechaza la contabilidad con un código que no
 * existe, y uno que existe pero está mal manda el saldo a otro renglón.
 */
export function resolverAgrupador(cuenta: CuentaListado): AgrupadorResuelto {
  if (!cuenta.agrupador.trim()) return { codAgrup: null, via: "sin-agrupador" };

  const candidatos = POR_NOMBRE.get(normalizar(cuenta.agrupador));
  if (!candidatos?.length) return { codAgrup: null, via: "nombre-desconocido" };
  if (candidatos.length === 1) return { codAgrup: candidatos[0], via: "nombre-unico" };

  const suMayor = cuenta.codigo.slice(0, 3);
  const mismoMayor = candidatos.filter((c) => c.split(".")[0] === suMayor);
  const pool = mismoMayor.length > 0 ? mismoMayor : candidatos;
  if (pool.length === 1) return { codAgrup: pool[0], via: "por-mayor" };

  const padres = pool.filter((c) => !c.includes("."));
  const hijos = pool.filter((c) => c.includes("."));
  if (cuenta.esDeMayor && padres.length === 1) return { codAgrup: padres[0], via: "padre" };
  if (!cuenta.esDeMayor && hijos.length === 1) return { codAgrup: hijos[0], via: "hijo" };

  return { codAgrup: null, via: "ambiguo", candidatos: pool };
}

/** Los encabezados que el listado trae, en el orden en que los exporta. */
const COL = { codigo: 0, nombre: 1, tipo: 2, mayor: 3, moneda: 4, agrupador: 5 } as const;

/**
 * Convierte las filas crudas de la hoja en cuentas.
 *
 * El archivo trae un preámbulo (título, fecha, los filtros aplicados) antes del
 * encabezado real, así que se busca la fila que empieza con «Cuenta» en vez de
 * saltar un número fijo de renglones: el preámbulo cambia de largo según los
 * filtros con los que se haya exportado.
 */
export function parseListadoCuentas(filas: unknown[][]): CuentaListado[] {
  const txt = (f: unknown[], i: number) => String(f?.[i] ?? "").trim();
  const encabezado = filas.findIndex(
    (f) => txt(f, COL.codigo).toLowerCase() === "cuenta" && txt(f, COL.nombre).toLowerCase().startsWith("nombre"),
  );
  if (encabezado < 0) return [];

  const cuentas: CuentaListado[] = [];
  for (const f of filas.slice(encabezado + 1)) {
    const codigo = txt(f, COL.codigo);
    if (!/^\d+$/.test(codigo)) continue;
    const nombre = txt(f, COL.nombre);
    if (!nombre) continue;
    cuentas.push({
      codigo,
      nombre,
      naturaleza: /acreedora/i.test(txt(f, COL.tipo)) ? "A" : "D",
      // «Si» y «De Título» agrupan; «No» recibe movimientos.
      esDeMayor: txt(f, COL.mayor).toLowerCase() !== "no",
      agrupador: txt(f, COL.agrupador),
      nivel: nivelDeCodigo(codigo),
    });
  }
  return cuentas;
}

/**
 * El nivel sale de los bloques de tres dígitos: 101000000 es mayor, 101001000
 * es subcuenta y 101001001 es sub-subcuenta. Se calcula del código y no de la
 * columna «Cuenta de mayor» porque esa dice si AGRUPA, no a qué profundidad
 * está: una cuenta de tercer nivel sin hijos también dice «No».
 */
export function nivelDeCodigo(codigo: string): number {
  if (codigo.length % 3 !== 0) return 1;
  const bloques: string[] = [];
  for (let i = 0; i < codigo.length; i += 3) bloques.push(codigo.slice(i, i + 3));
  let nivel = 1;
  for (let i = 1; i < bloques.length; i++) if (bloques[i] !== "000") nivel = i + 1;
  return nivel;
}

/**
 * La cuenta contable de una cuenta BANCARIA, buscada por número.
 *
 * Hace falta porque si `BankAccount.chartAccountId` está vacío el motor se
 * INVENTA una subcuenta («102.01.01 Bancos nacionales — BBVA 9012») en vez de
 * usar la de la empresa, y entonces el saldo de bancos vive en una cuenta que
 * su contabilidad no conoce. El listado del hospital nombra las suyas con el
 * número dentro —«Bancomer Cta 0120809012»—, que es la única señal confiable:
 * el nombre del banco se repite (tiene dos cuentas Bancomer) y el orden no
 * significa nada.
 *
 * Exige que la cuenta esté bajo el agrupador de bancos y que el número aparezca
 * COMPLETO. Empatar por los últimos cuatro dígitos es tentador y es justo como
 * se le asigna el dinero a la cuenta equivocada.
 */
export function cuentaBancariaEnListado<T extends { codigo: string; nombre: string; codAgrup?: string | null }>(
  numeroCuenta: string,
  cuentas: T[],
): T | null {
  const numero = numeroCuenta.replace(/\D/g, "");
  if (numero.length < 6) return null;
  const candidatas = cuentas.filter(
    (c) => c.codAgrup?.startsWith("102") && c.nombre.replace(/\D/g, "").includes(numero),
  );
  return candidatas.length === 1 ? candidatas[0] : null;
}
