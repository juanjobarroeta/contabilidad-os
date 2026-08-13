// ─────────────────────────────────────────────────────────────────────────────
// Importación de Contabilidad Electrónica (SAT, Anexo 24) — parsers PUROS.
//
// Dos documentos XML que el contador descarga del portal del SAT (o de su sistema
// contable) sirven para arrancar la contabilidad "real" de una empresa que migra
// a media vida:
//
//   1. Catálogo de Cuentas (namespace catalogocuentas) → el chart of accounts.
//      Cada <catalogocuentas:Ctas> trae CodAgrup (código agrupador SAT), NumCta
//      (clave interna de la empresa), Desc, Nivel y Natur (D/A).
//
//   2. Balanza de Comprobación (namespace BCE) → saldos de apertura. Cada
//      <BCE:Ctas> trae NumCta, SaldoIni, Debe, Haber y SaldoFin. El SaldoIni del
//      último mes presentado (o el SaldoFin del mes previo) son los saldos
//      iniciales con los que arranca la contabilidad en la app.
//
// Estos parsers son PUROS (sin DB / sin IO) para poder probarlos con vitest. La
// persistencia (upsert de ChartAccount, asiento de apertura) vive en rutas/módulos
// que los consumen y reutilizan apertura.ts — aquí NO se hace aritmética contable.
//
// El parseo es por expresión regular (mismo enfoque que parseCfdiXml en sat-fiel.ts):
// el XML del SAT es plano y de atributos, no requiere un DOM completo.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountType } from "@prisma/client";
import type { Naturaleza } from "./coe-saldos";

// ── Catálogo de Cuentas ──────────────────────────────────────────────────────

export interface CatalogoCuentaParsed {
  /** Código agrupador SAT (p.ej. "100", "102", "102.01"). */
  codAgrup: string;
  /** Clave interna de la empresa (NumCta del XML). */
  numCta: string;
  /** Nombre de la cuenta. */
  desc: string;
  /** Nivel jerárquico (1 = mayor, 2, 3, …). */
  nivel: number;
  /** Naturaleza COE: "D" (deudora) | "A" (acreedora). */
  natur: Naturaleza;
}

export interface CatalogoParseResult {
  rfc: string | null;
  cuentas: CatalogoCuentaParsed[];
}

/**
 * Deriva el tipo de cuenta a partir del primer dígito del código agrupador SAT
 * (Anexo 24): 1xx Activo, 2xx Pasivo, 3xx Capital, 4xx Ingreso, 5xx Costo,
 * 6xx/7xx/8xx Gasto. Es heurística pero suficiente para clasificar el catálogo
 * importado; la naturaleza D/A se toma SIEMPRE del XML (atributo Natur).
 */
export function tipoPorCodAgrup(codAgrup: string): AccountType {
  const first = codAgrup.trim().charAt(0);
  switch (first) {
    case "1":
      return "ACTIVO";
    case "2":
      return "PASIVO";
    case "3":
      return "CAPITAL";
    case "4":
      return "INGRESO";
    case "5":
      return "COSTO";
    default:
      // 6xx (gastos), 7xx (cuentas de orden / otros), 8xx → GASTO por defecto.
      return "GASTO";
  }
}

/** Lee un atributo XML de un fragmento de etiqueta (insensible al namespace). */
function attr(fragment: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(fragment)?.[1] ?? null;
}

/** Decodifica las entidades XML básicas en un valor de atributo. */
function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function natur(v: string | null): Naturaleza | null {
  const s = (v ?? "").trim().toUpperCase();
  if (s === "D") return "D";
  if (s === "A") return "A";
  return null;
}

/**
 * Parsea el XML del Catálogo de Cuentas (Anexo 24, namespace `catalogocuentas`).
 * Devuelve cada `Ctas` con su código agrupador, clave interna, nombre, nivel y
 * naturaleza. Omite nodos sin CodAgrup o sin naturaleza válida. Función PURA.
 */
export function parseCatalogoCuentas(xml: string): CatalogoParseResult {
  const rfc = attr(xml, "RFC");
  const cuentas: CatalogoCuentaParsed[] = [];

  // Cada cuenta es un <...:Ctas .../> auto-cerrado (o con cierre); tomamos sus atributos.
  const re = /<[A-Za-z0-9]*:?Ctas\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const a = m[1];
    const codAgrup = attr(a, "CodAgrup");
    if (!codAgrup) continue;
    const n = natur(attr(a, "Natur"));
    if (!n) continue;
    const numCta = attr(a, "NumCta") ?? codAgrup;
    const nivelRaw = attr(a, "Nivel");
    const nivel = nivelRaw != null && nivelRaw !== "" ? parseInt(nivelRaw, 10) : 1;
    cuentas.push({
      codAgrup: unescapeXml(codAgrup).trim(),
      numCta: unescapeXml(numCta).trim(),
      desc: unescapeXml(attr(a, "Desc") ?? "").trim(),
      nivel: Number.isFinite(nivel) && nivel > 0 ? nivel : 1,
      natur: n,
    });
  }

  return { rfc: rfc ? unescapeXml(rfc).trim() : null, cuentas };
}

// ── Balanza de Comprobación ──────────────────────────────────────────────────

export interface BalanzaCuentaParsed {
  numCta: string;
  saldoIni: number;
  debe: number;
  haber: number;
  saldoFin: number;
}

export interface BalanzaParseResult {
  rfc: string | null;
  /** Año (atributo Anio) si está presente. */
  anio: number | null;
  /** Mes (atributo Mes) si está presente. */
  mes: number | null;
  cuentas: BalanzaCuentaParsed[];
}

function num(v: string | null): number {
  if (v == null || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parsea el XML de la Balanza de Comprobación (Anexo 24, namespace `BCE`).
 * Devuelve cada `Ctas` con su clave (NumCta) y los importes SaldoIni/Debe/Haber/
 * SaldoFin tal cual vienen (MAGNITUD no negativa; el signo lo implica la
 * naturaleza de la cuenta en el catálogo). Función PURA.
 */
export function parseBalanza(xml: string): BalanzaParseResult {
  const rfc = attr(xml, "RFC");
  const anioRaw = attr(xml, "Anio");
  const mesRaw = attr(xml, "Mes");
  const cuentas: BalanzaCuentaParsed[] = [];

  const re = /<[A-Za-z0-9]*:?Ctas\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const a = m[1];
    const numCta = attr(a, "NumCta");
    if (!numCta) continue;
    cuentas.push({
      numCta: unescapeXml(numCta).trim(),
      saldoIni: num(attr(a, "SaldoIni")),
      debe: num(attr(a, "Debe")),
      haber: num(attr(a, "Haber")),
      saldoFin: num(attr(a, "SaldoFin")),
    });
  }

  const anio = anioRaw ? parseInt(anioRaw, 10) : NaN;
  const mes = mesRaw ? parseInt(mesRaw, 10) : NaN;
  return {
    rfc: rfc ? unescapeXml(rfc).trim() : null,
    anio: Number.isFinite(anio) ? anio : null,
    mes: Number.isFinite(mes) ? mes : null,
    cuentas,
  };
}

// ── Naturaleza deducida de la propia balanza (PURA) ──────────────────────────

/**
 * Naturaleza (D/A) de una cuenta DEDUCIDA de la aritmética de su renglón en la
 * balanza. Vale como CONTRASTE, no como regla primaria — ver la medición.
 *
 * El problema que venía a resolver: el catálogo que presenta la empresa suele
 * ser MÁS VIEJO que la balanza (una cuenta abierta a media vida no obliga a
 * remandar el catálogo). Esas cuentas llegan con saldo y sin naturaleza, se
 * caen de la apertura y el asiento no cuadra. En MARGOM son 119.
 *
 * La idea era que la balanza se delata sola: el Anexo 24 pide los cuatro
 * importes como MAGNITUD y el movimiento del periodo sólo cuadra de una manera,
 *
 *     deudora:   SaldoIni + Debe − Haber = SaldoFin
 *     acreedora: SaldoIni − Debe + Haber = SaldoFin
 *
 * así que con Debe ≠ Haber la que cuadra determinaría la naturaleza con certeza.
 *
 * NO SE SOSTUVO. Auditada contra las cuentas de la balanza real donde el SAT ya
 * dijo la respuesta (AMA170817NK1, 2026-06), la aritmética acierta 240 y falla
 * 58 —80.5%—, mientras que adivinar por el primer dígito del código acierta 393
 * y falla 24 —94.2%—. El primer dígito GANA. Las fallas de la aritmética se
 * concentran en cuentas 2xxx: en los pasivos la convención de magnitud del
 * documento no se comporta como supone la identidad.
 *
 * (Una versión anterior de este comentario citaba un 7.7% de error del primer
 * dígito. Esa cifra salía de agregar ChartAccount de las 17 empresas, no de la
 * balanza que se está importando; sobre la que importa es 5.8%.)
 *
 * Por eso la regla primaria es naturalezaPorTipo(tipoPorCodAgrup(numCta)) y
 * esta función se usa para CONTRASTAR: donde ambas coinciden hay confianza
 * alta; donde discrepan, se marca para revisión en vez de adivinar.
 *
 * Devuelve null cuando Debe = Haber (incluida la cuenta sin movimientos): ahí
 * las dos identidades cuadran y no hay nada que deducir.
 */
export function naturalezaPorAritmetica(
  c: Pick<BalanzaCuentaParsed, "saldoIni" | "debe" | "haber" | "saldoFin">,
  tolerancia = 0.01,
): Naturaleza | null {
  // Sin movimiento las dos identidades colapsan en SaldoIni = SaldoFin: la
  // balanza no dice de qué lado está el saldo. Cortamos aquí para no llamar
  // "deudora" a toda cuenta inactiva por el orden en que se prueban.
  if (Math.abs(c.debe - c.haber) < tolerancia) return null;

  const cuadraD = Math.abs(c.saldoIni + c.debe - c.haber - c.saldoFin) <= tolerancia;
  const cuadraA = Math.abs(c.saldoIni - c.debe + c.haber - c.saldoFin) <= tolerancia;

  // Ninguna cuadra: el renglón no es consistente (saldo inicial con signo,
  // redondeos gruesos, cuenta acumulada). No inventamos.
  if (cuadraD === cuadraA) return null;
  return cuadraD ? "D" : "A";
}

// ── Jerarquía del catálogo: qué cuenta es de DETALLE (PURA) ──────────────────

/**
 * Grupos significativos de un código de cuenta, ignorando el relleno de ceros.
 *
 *   1101-0101-0000 → ["1101","0101"]      102.01 → ["102","01"]
 *   1101-0000-0000 → ["1101"]             102    → ["102"]
 *
 * Se parte por cualquier separador y se tiran los grupos finales que son todo
 * ceros, que es como las empresas escriben un mayor en un código de ancho fijo.
 */
function gruposDeCodigo(codigo: string): string[] {
  const g = codigo.trim().split(/[.\-/]/);
  while (g.length > 1 && /^0+$/.test(g[g.length - 1])) g.pop();
  return g;
}

/**
 * Códigos de la balanza que son PADRE de algún otro código de la misma balanza.
 *
 * Importa porque la balanza del SAT trae el mayor Y sus subcuentas, y el saldo
 * del mayor YA es la suma de sus hijas: postear ambos duplica el subárbol
 * entero y la apertura no cuadra.
 *
 * La regla anterior partía por punto. Medida sobre la balanza real de MARGOM
 * —544 cuentas, TODAS con guion y ninguna con punto— encontraba 0 padres, así
 * que 103 mayores se posteaban como si fueran hojas junto con sus propias
 * hijas. Una regla de «prefijo + separador» tampoco sirve: 1101-0101-0000 no
 * empieza con 1101-0000-0000, que es como se escribe su mayor. Medida, también
 * encontraba 0.
 *
 * Comparar por GRUPOS resuelve las dos formas a la vez y no supone cuál es el
 * separador ni cuántos niveles hay. Medida sobre la misma balanza: 103 padres.
 */
export function padresDeBalanza(codigos: Iterable<string>): Set<string> {
  const lista = [...codigos];
  // Claves de todos los ancestros propios que aparecen implícitos en algún código.
  const ancestros = new Set<string>();
  for (const codigo of lista) {
    const g = gruposDeCodigo(codigo);
    for (let i = 1; i < g.length; i++) ancestros.add(g.slice(0, i).join(" "));
  }
  const padres = new Set<string>();
  for (const codigo of lista) {
    if (ancestros.has(gruposDeCodigo(codigo).join(" "))) padres.add(codigo);
  }
  return padres;
}

// ── Conversión balanza → saldos de apertura (PURA) ───────────────────────────

export interface AperturaLineaCodigo {
  codigo: string;
  /** Saldo con SIGNO NATURAL de la cuenta (positivo = en su naturaleza). */
  saldo: number;
}

/**
 * Convierte las cuentas de una balanza en líneas { codigo, saldo } con signo
 * NATURAL, listas para `postApertura` (que ya construye la partida doble).
 *
 *   • `usar` decide la base: "inicial" toma SaldoIni (apertura del periodo),
 *     "final" toma SaldoFin (cierre del periodo = apertura del siguiente).
 *   • El importe del XML es MAGNITUD (no negativa); se emite con signo natural
 *     positivo. El cruce de naturaleza/lado lo resuelve `postApertura` al armar
 *     la partida doble — aquí NO se hace aritmética contable.
 *   • Sólo se incluyen cuentas con naturaleza conocida (las del catálogo importado).
 *     Las cuentas agregadas de mayor/subcuenta duplicarían los saldos: el filtro
 *     de detalle se delega al llamador vía `incluir`.
 */
export function balanzaASaldosApertura(args: {
  cuentas: BalanzaCuentaParsed[];
  usar: "inicial" | "final";
  /** Naturaleza por código (D/A); null/undefined = se omite la cuenta. */
  naturalezaPorCodigo: (numCta: string) => Naturaleza | null | undefined;
  /** Filtro opcional: incluir esta cuenta (p.ej. sólo cuentas de detalle). */
  incluir?: (numCta: string) => boolean;
}): AperturaLineaCodigo[] {
  const lineas: AperturaLineaCodigo[] = [];
  for (const c of args.cuentas) {
    if (args.incluir && !args.incluir(c.numCta)) continue;
    const nat = args.naturalezaPorCodigo(c.numCta);
    if (nat !== "D" && nat !== "A") continue;

    const magnitud = args.usar === "inicial" ? c.saldoIni : c.saldoFin;
    if (Math.abs(magnitud) < 0.005) continue;

    lineas.push({ codigo: c.numCta, saldo: Math.abs(magnitud) });
  }
  return lineas;
}

// ── Diagnóstico del asiento de apertura (PURO) ───────────────────────────────

export interface DiagnosticoApertura {
  cuentas: number;
  /** Suma que vería postApertura HOY, con la regla de magnitud absoluta. */
  seleccion: { lineas: number; cargos: number; abonos: number; diferencia: number };
  /** La misma suma respetando el signo del saldo. Si ésta cuadra y la otra no,
   *  el defecto es el valor absoluto, no la selección de cuentas. */
  conSigno: { cargos: number; abonos: number; diferencia: number };
  /** Cuentas cuyo saldo corre CONTRA su naturaleza (saldo negativo en la
   *  balanza). Son las únicas en las que las dos sumas de arriba difieren. */
  contrarias: {
    cuentas: number;
    /** Σ|saldo| de las de naturaleza D y de las A: la diferencia entre ambas,
     *  por dos, es exactamente lo que el valor absoluto descuadra. */
    montoD: number;
    montoA: number;
    ejemplos: Array<{ codigo: string; naturaleza: Naturaleza; saldo: number }>;
  };
  /** Dinero que NO llega al asiento, por el motivo que lo deja fuera. */
  excluidas: {
    porPadre: { cuentas: number; monto: number };
    porCatalogo: { cuentas: number; monto: number; ejemplos: string[] };
    porNaturaleza: { cuentas: number; monto: number; ejemplos: string[] };
  };
  /** Lo incluido, por familia (primer dígito). Localiza el hueco de un vistazo. */
  porFamilia: Array<{ familia: string; cuentas: number; cargos: number; abonos: number }>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Explica, peso por peso, por qué el asiento de apertura no cuadra.
 *
 * `postApertura` sólo dice «cargos X vs abonos Y»; con eso no se puede saber si
 * sobran cuentas, si faltan, o si están del lado equivocado. Esta función
 * reproduce la MISMA selección que hace `importarBalanza` y reparte el descuadre
 * en cubetas con nombre, para no tener que adivinar cuál de los candidatos es.
 *
 * Función PURA: no toca la BD ni la red. El llamador le pasa la jerarquía y el
 * catálogo ya resueltos.
 */
export function diagnosticoApertura(args: {
  cuentas: BalanzaCuentaParsed[];
  usar: "inicial" | "final";
  esPadre: (numCta: string) => boolean;
  enCatalogo: (numCta: string) => boolean;
  naturalezaPorCodigo: (numCta: string) => Naturaleza | null | undefined;
}): DiagnosticoApertura {
  const sel = { lineas: 0, cargos: 0, abonos: 0 };
  const firmado = { cargos: 0, abonos: 0 };
  const contra = { cuentas: 0, montoD: 0, montoA: 0 };
  const ejemplosContra: Array<{ codigo: string; naturaleza: Naturaleza; saldo: number }> = [];
  const exPadre = { cuentas: 0, monto: 0 };
  const exCatalogo = { cuentas: 0, monto: 0, ejemplos: [] as string[] };
  const exNaturaleza = { cuentas: 0, monto: 0, ejemplos: [] as string[] };
  const familias = new Map<string, { cuentas: number; cargos: number; abonos: number }>();

  for (const c of args.cuentas) {
    const saldo = args.usar === "inicial" ? c.saldoIni : c.saldoFin;
    if (Math.abs(saldo) < 0.005) continue;

    if (args.esPadre(c.numCta)) {
      exPadre.cuentas++;
      exPadre.monto = r2(exPadre.monto + Math.abs(saldo));
      continue;
    }
    if (!args.enCatalogo(c.numCta)) {
      exCatalogo.cuentas++;
      exCatalogo.monto = r2(exCatalogo.monto + Math.abs(saldo));
      if (exCatalogo.ejemplos.length < 20) exCatalogo.ejemplos.push(c.numCta);
      continue;
    }
    const nat = args.naturalezaPorCodigo(c.numCta);
    if (nat !== "D" && nat !== "A") {
      exNaturaleza.cuentas++;
      exNaturaleza.monto = r2(exNaturaleza.monto + Math.abs(saldo));
      if (exNaturaleza.ejemplos.length < 20) exNaturaleza.ejemplos.push(c.numCta);
      continue;
    }

    // Lo que hace HOY: la magnitud va siempre del lado de la naturaleza.
    sel.lineas++;
    const mag = Math.abs(saldo);
    if (nat === "D") sel.cargos = r2(sel.cargos + mag);
    else sel.abonos = r2(sel.abonos + mag);

    // Lo que debería hacer: un saldo negativo corre contra la naturaleza y va
    // del lado contrario.
    const debe = (nat === "D") === saldo >= 0;
    if (debe) firmado.cargos = r2(firmado.cargos + mag);
    else firmado.abonos = r2(firmado.abonos + mag);

    if (saldo < 0) {
      contra.cuentas++;
      if (nat === "D") contra.montoD = r2(contra.montoD + mag);
      else contra.montoA = r2(contra.montoA + mag);
      if (ejemplosContra.length < 20)
        ejemplosContra.push({ codigo: c.numCta, naturaleza: nat, saldo: r2(saldo) });
    }

    const fam = c.numCta.trim().charAt(0) || "?";
    const f = familias.get(fam) ?? { cuentas: 0, cargos: 0, abonos: 0 };
    f.cuentas++;
    if (nat === "D") f.cargos = r2(f.cargos + mag);
    else f.abonos = r2(f.abonos + mag);
    familias.set(fam, f);
  }

  return {
    cuentas: args.cuentas.length,
    seleccion: { ...sel, diferencia: r2(sel.cargos - sel.abonos) },
    conSigno: { ...firmado, diferencia: r2(firmado.cargos - firmado.abonos) },
    contrarias: { ...contra, ejemplos: ejemplosContra },
    excluidas: { porPadre: exPadre, porCatalogo: exCatalogo, porNaturaleza: exNaturaleza },
    porFamilia: [...familias.entries()]
      .map(([familia, v]) => ({ familia, ...v }))
      .sort((a, b) => a.familia.localeCompare(b.familia)),
  };
}
