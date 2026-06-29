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
