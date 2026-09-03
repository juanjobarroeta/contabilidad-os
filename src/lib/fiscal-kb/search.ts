// Búsqueda sobre el knowledge base fiscal, filtrada por vigencia para que una
// pregunta de un periodo pasado recupere la ley en vigor entonces. Devuelve
// chunks CON su cita — el asistente fundamenta cada afirmación fiscal en estos
// resultados y dice cuando no hay base.
//
// Modos (Fase 2 del plan del copiloto, «recuperar como fiscalista»):
//   - "vector": vecinos más cercanos por embedding (lo de siempre).
//   - "hibrido": vector + léxico (tsvector en español) + referencias exactas
//     que la pregunta nombra («artículo 27 de la LISR»), fusionados por RRF.
//   - rerank opcional: un modelo barato reordena los ~20 fusionados.
// Cada palanca es una opción para que el eval mida cada una por separado; el
// default de producción se fija con el número (env FISCAL_KB_MODO /
// FISCAL_KB_RERANK) — lo que no mueve el número, no se queda.
//
// Design doc: docs/FISCAL-KNOWLEDGE-BASE.md §8–9.

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { embedQuery, toVectorLiteral } from "./embed";
import type { CostCtx } from "@/lib/costos/record";
import { diversificarPorUnidad } from "./diversificar";
import { fusionarRRF, referenciasExactas } from "./fusion";
import { rerankCandidatos } from "./rerank";

export type ModoBusqueda = "vector" | "hibrido";

export interface FiscalSearchOptions {
  /** Fecha del periodo fiscal relevante. Default: hoy. */
  fechaVigencia?: Date;
  /** Filtrar por tipo de fuente: LEY | RMF | CRITERIO | DOF | REGLAMENTO | TESIS | GUIA. */
  fuentes?: string[];
  limit?: number;
  /** Piso de confianza del brazo vector — debajo se reporta «sin fundamento» antes que un match débil. */
  minSimilarity?: number;
  /** "vector" (default) | "hibrido". Default por env FISCAL_KB_MODO. */
  modo?: ModoBusqueda;
  /** Reordenar los candidatos con un modelo barato antes de entregar. Default por env FISCAL_KB_RERANK=1. */
  rerank?: boolean;
  /** Atribución del costo (embedding de la consulta, rerank) a la empresa/usuario que consulta. */
  cost?: CostCtx;
}

export interface FiscalSearchHit {
  cita: string; // "Art. 113-E LISR" | "LISR — TRANSITORIOS"
  texto: string;
  fuente: string; // FiscalSource
  ley: string; // clave
  titulo: string;
  url: string;
  articulo: string | null;
  contexto: string | null;
  vigenciaDesde: string; // ISO date
  publicadoDof: string | null;
  similitud: number;
}

export interface FiscalSearchResult {
  resultados: FiscalSearchHit[];
  fechaVigenciaConsultada: string;
  /** Qué brazos y ajustes produjeron el resultado (para la traza y el eval). */
  busqueda: { modo: ModoBusqueda; rerank: boolean; referenciasExactas: string[] };
  aviso?: string;
}

const DEFAULT_LIMIT = 6;
const DEFAULT_MIN_SIMILARITY = 0.25;
/** Candidatos que ve el rerank. */
const CANDIDATOS_RERANK = 20;

function modoPorDefecto(): ModoBusqueda {
  return process.env.FISCAL_KB_MODO === "hibrido" ? "hibrido" : "vector";
}
function rerankPorDefecto(): boolean {
  return process.env.FISCAL_KB_RERANK === "1" || process.env.FISCAL_KB_RERANK === "true";
}

/** Source-aware citation label: leyes cite artículos, RMF cita reglas, guías su título. */
export function buildCita(source: string, clave: string, articulo: string | null, titulo: string): string {
  if (articulo === "TRANSITORIOS") return `${clave} — TRANSITORIOS`;
  switch (source) {
    case "LEY":
    case "REGLAMENTO":
      return articulo ? `Art. ${articulo} ${clave}` : clave;
    case "RMF":
      return articulo ? `Regla ${articulo} ${clave}` : clave;
    case "GUIA":
      return titulo; // guías no tienen numeración de artículo
    default:
      return articulo ? `${clave} ${articulo}` : clave;
  }
}

interface Row {
  id: string;
  documentId: string;
  articulo: string | null;
  parte: number | null;
  contexto: string | null;
  texto: string;
  vigenciaDesde: Date;
  source: string;
  clave: string;
  titulo: string;
  url: string;
  publicadoDof: Date | null;
  similitud: number;
}

const COLUMNAS = Prisma.sql`
  c."id", c."documentId", c."articulo", c."parte", c."contexto", c."texto", c."vigenciaDesde",
  d."source"::text AS "source", d."clave", d."titulo", d."url", d."publicadoDof"`;

function filtroVigencia(fecha: Date) {
  return Prisma.sql`c."vigenciaDesde" <= ${fecha} AND (c."vigenciaHasta" IS NULL OR c."vigenciaHasta" >= ${fecha})`;
}

function filtroFuentes(fuentes?: string[]) {
  return fuentes && fuentes.length > 0 ? Prisma.sql`AND d."source"::text IN (${Prisma.join(fuentes)})` : Prisma.empty;
}

/** Brazo vector: vecinos más cercanos por coseno. */
async function brazoVector(vec: string, fecha: Date, fuentes: string[] | undefined, n: number): Promise<Row[]> {
  return prisma.$queryRaw<Row[]>`
    SELECT ${COLUMNAS}, 1 - (c."embedding" <=> ${vec}::vector) AS "similitud"
    FROM "FiscalChunk" c
    JOIN "FiscalDocument" d ON d."id" = c."documentId"
    WHERE ${filtroVigencia(fecha)}
      ${filtroFuentes(fuentes)}
    ORDER BY c."embedding" <=> ${vec}::vector
    LIMIT ${n}`;
}

/** Brazo léxico: tsvector en español (columna generada + GIN, ver migración fiscal_chunk_tsv). */
async function brazoLexico(query: string, vec: string, fecha: Date, fuentes: string[] | undefined, n: number): Promise<Row[]> {
  return prisma.$queryRaw<Row[]>`
    SELECT ${COLUMNAS}, 1 - (c."embedding" <=> ${vec}::vector) AS "similitud",
      ts_rank_cd(c."tsv", websearch_to_tsquery('spanish', ${query})) AS "rankLex"
    FROM "FiscalChunk" c
    JOIN "FiscalDocument" d ON d."id" = c."documentId"
    WHERE c."tsv" @@ websearch_to_tsquery('spanish', ${query})
      AND ${filtroVigencia(fecha)}
      ${filtroFuentes(fuentes)}
    ORDER BY "rankLex" DESC
    LIMIT ${n}`;
}

/** Variantes con que una ley escribe el mismo número: LIVA/CFF usan ordinal («5o», «1o-A»). */
function variantesArticulo(articulo: string): string[] {
  const m = articulo.match(/^(\d+)(-.*)?$/);
  if (!m) return [articulo];
  return [articulo, `${m[1]}o${m[2] ?? ""}`];
}

/** Brazo exacto: los chunks del artículo/regla que la pregunta nombra. */
async function brazoExacto(query: string, vec: string, fecha: Date, fuentes: string[] | undefined): Promise<{ rows: Row[]; refs: string[] }> {
  const refs = referenciasExactas(query);
  const rows: Row[] = [];
  for (const r of refs) {
    const filtroClave =
      r.clave === null
        ? Prisma.empty
        : r.clave === "RMF"
          ? Prisma.sql`AND d."clave" LIKE 'RMF%'`
          : Prisma.sql`AND d."clave" = ${r.clave}`;
    rows.push(
      ...(await prisma.$queryRaw<Row[]>`
        SELECT ${COLUMNAS}, 1 - (c."embedding" <=> ${vec}::vector) AS "similitud"
        FROM "FiscalChunk" c
        JOIN "FiscalDocument" d ON d."id" = c."documentId"
        WHERE c."articulo" IN (${Prisma.join(variantesArticulo(r.articulo))})
          ${filtroClave}
          AND ${filtroVigencia(fecha)}
          ${filtroFuentes(fuentes)}
        ORDER BY 1 - (c."embedding" <=> ${vec}::vector) DESC
        LIMIT 6`)
    );
  }
  return { rows, refs: refs.map((r) => `${r.clave ?? "?"} ${r.articulo}`) };
}

function aHit(r: Row): FiscalSearchHit {
  return {
    cita: buildCita(r.source, r.clave, r.articulo, r.titulo),
    texto: r.texto,
    fuente: r.source,
    ley: r.clave,
    titulo: r.titulo,
    url: r.url,
    articulo: r.articulo,
    contexto: r.contexto,
    vigenciaDesde: r.vigenciaDesde.toISOString().slice(0, 10),
    publicadoDof: r.publicadoDof ? r.publicadoDof.toISOString().slice(0, 10) : null,
    similitud: Math.round(r.similitud * 1000) / 1000,
  };
}

export async function searchFiscalKnowledge(query: string, opts: FiscalSearchOptions = {}): Promise<FiscalSearchResult> {
  const fecha = opts.fechaVigencia ?? new Date();
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, 20);
  const minSim = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  const modo = opts.modo ?? modoPorDefecto();
  const rerank = opts.rerank ?? rerankPorDefecto();
  // Se piden MÁS filas de las que se entregan: el piso de similitud se aplica
  // en JS y antes se aplicaba sobre las `limit` primeras — una consulta cuyos
  // 6 vecinos más cercanos fueran débiles devolvía CERO aunque hubiera
  // artículos buenos en la posición 7. Cortar a `limit` después del piso.
  const candidatos = Math.min(limit * 4, 40);

  const vec = toVectorLiteral(await embedQuery(query, opts.cost ? { ...opts.cost, subtipo: "kb.embed_query" } : undefined));

  let ordenados: Row[];
  let refs: string[] = [];
  if (modo === "hibrido") {
    const [exacto, vector, lexico] = await Promise.all([
      brazoExacto(query, vec, fecha, opts.fuentes),
      brazoVector(vec, fecha, opts.fuentes, candidatos),
      brazoLexico(query, vec, fecha, opts.fuentes, candidatos),
    ]);
    refs = exacto.refs;
    const enVector = new Set(vector.map((r) => r.id));
    const enOtros = new Set([...exacto.rows, ...lexico].map((r) => r.id));
    // El piso sólo juzga a lo que únicamente el vector propuso; un chunk que
    // también ganó por palabras o por número exacto no necesita parecerse.
    const fusion = fusionarRRF([exacto.rows, vector, lexico], (r) => r.id).map((f) => f.item);
    const sinPiso = fusion.filter((r) => enOtros.has(r.id) || (enVector.has(r.id) && r.similitud >= minSim));
    // Lo que la pregunta nombra por número va primero, sin pedirle permiso al embedding.
    const exactos = new Set(exacto.rows.map((r) => r.id));
    ordenados = [...sinPiso.filter((r) => exactos.has(r.id)), ...sinPiso.filter((r) => !exactos.has(r.id))];
  } else {
    ordenados = (await brazoVector(vec, fecha, opts.fuentes, candidatos)).filter((r) => r.similitud >= minSim);
  }

  if (rerank && ordenados.length > 1) {
    const top = ordenados.slice(0, CANDIDATOS_RERANK);
    const reordenados = await rerankCandidatos(
      query,
      top.map((r) => ({ ...r, cita: buildCita(r.source, r.clave, r.articulo, r.titulo) }),
      { cost: opts.cost }
    );
    if (reordenados) ordenados = [...reordenados, ...ordenados.slice(CANDIDATOS_RERANK)];
  }

  // A lo más 2 chunks por UNIDAD legal (artículo/regla; una guía entera es una
  // unidad): una guía larga no debe acaparar el top-6, pero dos artículos de la
  // misma ley nunca compiten entre sí (ver diversificar.ts).
  const resultados = diversificarPorUnidad(ordenados, limit).map(aHit);

  const result: FiscalSearchResult = {
    resultados,
    fechaVigenciaConsultada: fecha.toISOString().slice(0, 10),
    busqueda: { modo, rerank, referenciasExactas: refs },
  };
  if (resultados.length === 0) {
    result.aviso =
      "Sin fundamento suficiente en el knowledge base para esta consulta. NO inventes un fundamento legal; dilo explícitamente y sugiere verificar con un contador.";
  }
  return result;
}

// ── Un artículo completo por número ──────────────────────────────────────────

export interface ArticuloCompleto {
  cita: string;
  ley: string;
  titulo: string;
  url: string;
  articulo: string;
  contexto: string | null;
  vigenciaDesde: string;
  /** Todas las partes vigentes, en orden. */
  partes: { parte: number | null; texto: string }[];
}

/**
 * Trae un artículo/regla entero (todas sus partes) por clave y número. Es la
 * cadena que un fiscalista recorre: el RLISR dice «para los efectos del
 * artículo 27 de la Ley» y el agente va y lo lee, en vez de adivinarlo.
 */
export async function getArticulo(clave: string, articulo: string, fechaVigencia?: Date): Promise<ArticuloCompleto | null> {
  const fecha = fechaVigencia ?? new Date();
  const claveUp = clave.trim().toUpperCase();
  const filtroClave = claveUp === "RMF" ? Prisma.sql`d."clave" LIKE 'RMF%'` : Prisma.sql`d."clave" = ${claveUp}`;
  const rows = await prisma.$queryRaw<Omit<Row, "similitud">[]>`
    SELECT ${COLUMNAS}
    FROM "FiscalChunk" c
    JOIN "FiscalDocument" d ON d."id" = c."documentId"
    WHERE ${filtroClave}
      AND c."articulo" IN (${Prisma.join(variantesArticulo(articulo.trim()))})
      AND ${filtroVigencia(fecha)}
    ORDER BY c."parte" ASC NULLS FIRST`;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    cita: buildCita(r.source, r.clave, r.articulo, r.titulo),
    ley: r.clave,
    titulo: r.titulo,
    url: r.url,
    articulo: r.articulo ?? articulo,
    contexto: r.contexto,
    vigenciaDesde: r.vigenciaDesde.toISOString().slice(0, 10),
    partes: rows.map((x) => ({ parte: x.parte, texto: x.texto })),
  };
}
