// ─────────────────────────────────────────────────────────────────────────────
// CATÁLOGO DE CUENTAS Y BALANZA EN CSV / EXCEL — parsers PUROS.
//
// El XML del Anexo 24 es lo ideal, pero una empresa que no presenta
// Contabilidad Electrónica (RESICO, personas físicas chicas) sólo tiene la
// exportación de su sistema: CONTPAQi («Código, Nombre, Tipo, Naturaleza,
// Nivel, Código agrupador SAT»), Aspel COI («Cuenta; Descripción; Naturaleza;
// Nivel; Agrupador»), o una hoja que armó el contador a mano. Aquí se leen
// esas tablas y salen con la MISMA forma que el parser del XML
// (CatalogoCuentaParsed / BalanzaParseResult), para que el resto del camino
// —upsert, apertura, jerarquía— no sepa de dónde vinieron.
//
// Lo que la tabla no trae se completa con lo que sí trae, en este orden:
//   · nivel: de la columna; si no, de la cadena de padres (columna «subcuenta
//     de»); si no, de los segmentos del código.
//   · naturaleza: de la columna (D/A, Deudora/Acreedora); si no, del agrupador
//     (activo, costo y gasto son deudoras; pasivo, capital e ingreso,
//     acreedoras); si no, de la columna «tipo». Sin ninguna, la fila se omite y
//     se avisa: adivinar el lado de una cuenta es peor que no importarla.
// ─────────────────────────────────────────────────────────────────────────────

import * as XLSX from "xlsx";
import { tipoPorCodAgrup, type BalanzaParseResult, type CatalogoCuentaParsed } from "./ce-import";
import { naturalezaPorTipo, type Naturaleza } from "./coe-saldos";
import { esAgrupadorOficial } from "./agrupador";
import { CODIGO_AGRUPADOR_OFICIAL } from "./codigo-agrupador";
import { segmentosDeCodigo } from "./jerarquia-catalogo";

/**
 * EL AGRUPADOR TAL COMO LO ESCRIBE CADA SISTEMA: código o NOMBRE.
 *
 * CONTPAQi exporta «115.01»; el sistema de un hospital exporta «Inventario» en
 * una columna que igual se llama «Agrupador del SAT». Copiar la celda tal cual
 * dejaba `codAgrup = "Inventario"` —que no es del Anexo 24— y con eso el SAT
 * rechaza el catálogo y el motor no puede invertir ni una cuenta: el contador
 * ve «2 340 cuentas sin agrupador válido» sobre un archivo que traía el dato
 * completo, sólo que escrito con letras.
 *
 * Los nombres del Anexo 24 son una lista cerrada, así que traducirlos no es
 * adivinar. Un nombre que no esté en la lista se deja como vino: inventarse un
 * código sería peor que no poner ninguno.
 */
export function agrupadorDeCelda(texto: string): string {
  const crudo = (texto ?? "").trim();
  if (!crudo) return "";
  const comoCodigo = crudo.replace(/\s+/g, "");
  if (esAgrupadorOficial(comoCodigo)) return comoCodigo;
  const porNombre = CODIGO_POR_NOMBRE.get(normalizarNombreAgrupador(crudo));
  return porNombre ?? comoCodigo;
}

/** Sin acentos, sin signos y en minúsculas: «Ventas y/o servicios gravados al 0%». */
function normalizarNombreAgrupador(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Nombre oficial → código. Un mismo nombre puede estar en dos niveles
 * («Inventario» es 115 y también 115.01), y gana EL MÁS ESPECÍFICO: la cuenta
 * que alguien nombró «Inventario» en su plan es de detalle, y es 115.01 lo que
 * el SAT ya aceptó en los catálogos presentados. Entre dos del mismo nivel
 * («Ingresos» es 400 y 401) gana el menor, que es el que agrupa.
 */
const CODIGO_POR_NOMBRE = new Map<string, string>();
const profundidad = (c: string) => c.split(".").length;
for (const [codigo, nombre] of Object.entries(CODIGO_AGRUPADOR_OFICIAL)) {
  const k = normalizarNombreAgrupador(nombre);
  const previo = CODIGO_POR_NOMBRE.get(k);
  if (
    !previo ||
    profundidad(codigo) > profundidad(previo) ||
    (profundidad(codigo) === profundidad(previo) && codigo < previo)
  ) {
    CODIGO_POR_NOMBRE.set(k, codigo);
  }
}

export type ColumnaCatalogo = "codigo" | "nombre" | "agrupador" | "nivel" | "naturaleza" | "padre" | "tipo";
export type ColumnaBalanza = "codigo" | "nombre" | "saldoIni" | "debe" | "haber" | "saldoFin";

const SINONIMOS_CATALOGO: Record<ColumnaCatalogo, RegExp> = {
  codigo: /^(c[oó]digo|cuenta|num ?cta|n[uú]mero( de)? cuenta|no\.? ?(de )?cuenta|clave|cta)$/i,
  nombre: /^(nombre|descripci[oó]n|desc|concepto|nombre( de la)? cuenta)$/i,
  agrupador: /agrupador|cod ?agrup|c[oó]digo ?sat|cuenta ?sat|sat$/i,
  nivel: /^nivel$/i,
  naturaleza: /^(naturaleza|natur|nat)$/i,
  padre: /sub ?cta ?de|sub ?cuenta ?de|cuenta ?padre|^padre$|depende ?de|cuenta ?superior/i,
  tipo: /^tipo( de cuenta)?$/i,
};

const SINONIMOS_BALANZA: Record<ColumnaBalanza, RegExp> = {
  codigo: /^(c[oó]digo|cuenta|num ?cta|n[uú]mero( de)? cuenta|no\.? ?(de )?cuenta|clave|cta)$/i,
  nombre: /^(nombre|descripci[oó]n|desc|concepto)$/i,
  saldoIni: /saldo ?inicial|saldo ?ini|inicial/i,
  debe: /^(debe|cargos?|movimientos? ?deudor(es)?|d[eé]bitos?)$/i,
  haber: /^(haber|abonos?|movimientos? ?acreedor(es)?|cr[eé]ditos?)$/i,
  saldoFin: /saldo ?final|saldo ?fin|^final$|saldo ?actual/i,
};

/** Quita acentos y espacios repetidos para comparar encabezados. */
function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

/** CSV con «;» (Aspel, Excel en español) o con coma: se cuenta en la primera línea con datos. */
function separadorDe(texto: string): string {
  const linea = texto.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const cuenta = (ch: string) => linea.split(ch).length - 1;
  const candidatos: Array<[string, number]> = [[",", cuenta(",")], [";", cuenta(";")], ["\t", cuenta("\t")], ["|", cuenta("|")]];
  candidatos.sort((a, b) => b[1] - a[1]);
  return candidatos[0][1] > 0 ? candidatos[0][0] : ",";
}

/** Filas (como texto) de la primera hoja de un CSV o un libro de Excel. */
export function filasDeArchivo(contenido: string | Uint8Array): string[][] {
  const wb =
    typeof contenido === "string"
      ? XLSX.read(contenido.replace(/^﻿/, ""), { type: "string", raw: true, FS: separadorDe(contenido) })
      : XLSX.read(contenido, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const filas = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: false, defval: "" });
  return filas.map((f) => (Array.isArray(f) ? f : []).map((v) => String(v ?? "").trim()));
}

/**
 * Encuentra la fila de encabezados (la primera, entre las 30 iniciales, con al
 * menos dos columnas reconocidas) y devuelve la posición de cada columna.
 */
export function detectarColumnas<C extends string>(filas: string[][], sinonimos: Record<C, RegExp>): { fila: number; columnas: Partial<Record<C, number>> } | null {
  for (let i = 0; i < Math.min(filas.length, 30); i++) {
    const columnas: Partial<Record<C, number>> = {};
    filas[i].forEach((celda, j) => {
      const h = normalizar(celda);
      if (!h) return;
      for (const [col, re] of Object.entries(sinonimos) as Array<[C, RegExp]>) {
        if (columnas[col] === undefined && re.test(h)) { columnas[col] = j; break; }
      }
    });
    if (Object.keys(columnas).length >= 2 && columnas["codigo" as C] !== undefined) return { fila: i, columnas };
  }
  return null;
}

function naturalezaDe(v: string): Naturaleza | null {
  const s = normalizar(v).toUpperCase();
  if (s === "D" || s.startsWith("DEUD") || s === "DEBE" || s === "1") return "D";
  if (s === "A" || s.startsWith("ACRE") || s === "HABER" || s === "2") return "A";
  return null;
}

function naturalezaPorTipoTexto(v: string): Naturaleza | null {
  const s = normalizar(v).toUpperCase();
  if (/^ACTIVO|^GASTO|^COSTO/.test(s)) return "D";
  if (/^PASIVO|^CAPITAL|^INGRESO/.test(s)) return "A";
  return null;
}

export interface CatalogoTabularResult {
  cuentas: CatalogoCuentaParsed[];
  advertencias: string[];
  /** Qué encabezado se tomó para cada campo, para enseñarlo. */
  columnas: Partial<Record<ColumnaCatalogo, string>>;
}

/** Catálogo de cuentas desde CSV o Excel. Puro. */
export function parseCatalogoTabular(contenido: string | Uint8Array): CatalogoTabularResult {
  const filas = filasDeArchivo(contenido);
  const det = detectarColumnas(filas, SINONIMOS_CATALOGO);
  if (!det) {
    return { cuentas: [], advertencias: ["No encontré una fila de encabezados con al menos «código» y otra columna (nombre, agrupador, naturaleza…)."], columnas: {} };
  }
  const { fila, columnas } = det;
  const encabezado = filas[fila];
  const columnasTexto: Partial<Record<ColumnaCatalogo, string>> = {};
  for (const [k, j] of Object.entries(columnas) as Array<[ColumnaCatalogo, number]>) columnasTexto[k] = encabezado[j];
  const celda = (f: string[], col: ColumnaCatalogo) => (columnas[col] === undefined ? "" : (f[columnas[col]!] ?? "").trim());

  const advertencias: string[] = [];
  if (columnas.nombre === undefined) advertencias.push("Sin columna de nombre: las cuentas quedan con su código como nombre hasta que llegue un catálogo con descripción.");
  if (columnas.agrupador === undefined) advertencias.push("Sin columna de código agrupador SAT: el motor no podrá mapear estas cuentas hasta que se capture el agrupador.");

  type Parcial = { codigo: string; nombre: string; agrupador: string; nivel: number | null; natur: Naturaleza | null; padre: string | null; tipo: string };
  const parciales: Parcial[] = [];
  let sinCodigo = 0;
  let traducidasPorNombre = 0;
  for (let i = fila + 1; i < filas.length; i++) {
    const f = filas[i];
    if (f.every((c) => !c)) continue;
    const codigo = celda(f, "codigo").replace(/\s+/g, "");
    if (!codigo) { sinCodigo++; continue; }
    const nivelTxt = celda(f, "nivel");
    const nivelNum = nivelTxt ? parseInt(nivelTxt, 10) : NaN;
    const agrupadorCrudo = celda(f, "agrupador");
    const agrupador = agrupadorDeCelda(agrupadorCrudo);
    if (agrupador && agrupador !== agrupadorCrudo.replace(/\s+/g, "")) traducidasPorNombre++;
    parciales.push({
      codigo,
      nombre: celda(f, "nombre"),
      agrupador,
      nivel: Number.isFinite(nivelNum) && nivelNum > 0 ? nivelNum : null,
      natur: naturalezaDe(celda(f, "naturaleza")),
      padre: celda(f, "padre").replace(/\s+/g, "") || null,
      tipo: celda(f, "tipo"),
    });
  }
  if (sinCodigo > 0) advertencias.push(`${sinCodigo} fila(s) sin código se omitieron.`);
  // Se dice cuántas venían con letras, porque es una TRADUCCIÓN: quien revisa
  // tiene derecho a saber que el código no venía así en el archivo.
  if (traducidasPorNombre > 0) {
    advertencias.push(
      `${traducidasPorNombre} cuenta(s) traían el agrupador por NOMBRE («Inventario») y se tradujeron a su código del Anexo 24 («115.01»).`,
    );
  }

  // Nivel: columna → cadena de padres → segmentos del código.
  const porCodigo = new Map(parciales.map((p) => [p.codigo, p]));
  const nivelPorPadres = (p: Parcial, vistos = new Set<string>()): number | null => {
    if (!p.padre || !porCodigo.has(p.padre) || vistos.has(p.codigo)) return p.padre ? null : 1;
    vistos.add(p.codigo);
    const arriba = porCodigo.get(p.padre)!;
    const n = arriba.nivel ?? nivelPorPadres(arriba, vistos);
    return n == null ? null : n + 1;
  };
  const hayPadres = parciales.some((p) => p.padre && porCodigo.has(p.padre));

  const cuentas: CatalogoCuentaParsed[] = [];
  let sinNaturaleza = 0;
  for (const p of parciales) {
    const natur = p.natur ?? (p.agrupador ? naturalezaPorTipo(tipoPorCodAgrup(p.agrupador)) : null) ?? naturalezaPorTipoTexto(p.tipo);
    if (!natur) { sinNaturaleza++; continue; }
    const nivel = p.nivel ?? (hayPadres ? nivelPorPadres(p) : null) ?? Math.max(1, segmentosDeCodigo(p.codigo).length);
    cuentas.push({
      codAgrup: p.agrupador,
      numCta: p.codigo,
      desc: p.nombre,
      nivel,
      natur,
      subCtaDe: p.padre && porCodigo.has(p.padre) && p.padre !== p.codigo ? p.padre : null,
    });
  }
  if (sinNaturaleza > 0) advertencias.push(`${sinNaturaleza} cuenta(s) sin naturaleza ni agrupador ni tipo se omitieron: no se puede saber de qué lado van.`);

  return { cuentas, advertencias, columnas: columnasTexto };
}

/** «$1,234.56», «(500.00)», «-500», «1.234,56» → número. */
export function importeDeTexto(v: string): number {
  let s = v.replace(/[$\s]/g, "");
  if (!s || s === "-") return 0;
  let negativo = false;
  if (/^\(.*\)$/.test(s)) { negativo = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { negativo = !negativo; s = s.slice(1); }
  // Formato europeo (1.234,56) sólo si la coma es el último separador.
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return negativo ? -n : n;
}

export interface BalanzaTabularResult extends BalanzaParseResult {
  advertencias: string[];
  columnas: Partial<Record<ColumnaBalanza, string>>;
}

/** Balanza de comprobación desde CSV o Excel. Puro. */
export function parseBalanzaTabular(contenido: string | Uint8Array): BalanzaTabularResult {
  const filas = filasDeArchivo(contenido);
  const det = detectarColumnas(filas, SINONIMOS_BALANZA);
  const vacio: BalanzaTabularResult = { rfc: null, anio: null, mes: null, cuentas: [], advertencias: [], columnas: {} };
  if (!det) return { ...vacio, advertencias: ["No encontré una fila de encabezados con «cuenta» y saldos (inicial, cargos/debe, abonos/haber, final)."] };
  const { fila, columnas } = det;
  const encabezado = filas[fila];
  const columnasTexto: Partial<Record<ColumnaBalanza, string>> = {};
  for (const [k, j] of Object.entries(columnas) as Array<[ColumnaBalanza, number]>) columnasTexto[k] = encabezado[j];
  const celda = (f: string[], col: ColumnaBalanza) => (columnas[col] === undefined ? "" : (f[columnas[col]!] ?? "").trim());

  const advertencias: string[] = [];
  if (columnas.saldoIni === undefined && columnas.saldoFin === undefined) advertencias.push("La balanza no trae saldo inicial ni final: no hay con qué armar la apertura.");

  const cuentas = [];
  for (let i = fila + 1; i < filas.length; i++) {
    const f = filas[i];
    const codigo = celda(f, "codigo").replace(/\s+/g, "");
    if (!codigo || /^total/i.test(codigo)) continue;
    const saldoIni = importeDeTexto(celda(f, "saldoIni"));
    const debe = importeDeTexto(celda(f, "debe"));
    const haber = importeDeTexto(celda(f, "haber"));
    const saldoFinTxt = celda(f, "saldoFin");
    // Sin columna de saldo final se deriva: inicial + debe − haber (magnitud por naturaleza la decide la apertura).
    const saldoFin = saldoFinTxt ? importeDeTexto(saldoFinTxt) : saldoIni + debe - haber;
    cuentas.push({ numCta: codigo, saldoIni, debe, haber, saldoFin });
  }
  return { ...vacio, cuentas, advertencias, columnas: columnasTexto };
}
