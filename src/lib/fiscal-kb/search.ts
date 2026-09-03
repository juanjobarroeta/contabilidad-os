// Vector search over the fiscal knowledge base, filtered by vigencia so
// period-specific questions retrieve the law in force at that time. Returns
// chunks WITH their citation — the assistant must ground every fiscal claim
// in these results and say so when there's no basis.
//
// Design doc: docs/FISCAL-KNOWLEDGE-BASE.md §8–9.

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { embedQuery, toVectorLiteral } from "./embed";
import type { CostCtx } from "@/lib/costos/record";
import { diversificarPorUnidad } from "./diversificar";

export interface FiscalSearchOptions {
  /** Fecha del periodo fiscal relevante. Default: hoy. */
  fechaVigencia?: Date;
  /** Filtrar por tipo de fuente: LEY | RMF | CRITERIO | DOF | REGLAMENTO | TESIS. */
  fuentes?: string[];
  limit?: number;
  /** Confidence floor — below this we report "sin fundamento" over weak matches. */
  minSimilarity?: number;
  /** Atribución del costo del embedding (empresa/usuario que consulta). */
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
  aviso?: string;
}

const DEFAULT_LIMIT = 6;
const DEFAULT_MIN_SIMILARITY = 0.25;

/** Source-aware citation label: leyes cite artículos, RMF cita reglas, guías su título. */
function buildCita(source: string, clave: string, articulo: string | null, titulo: string): string {
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

export async function searchFiscalKnowledge(query: string, opts: FiscalSearchOptions = {}): Promise<FiscalSearchResult> {
  const fecha = opts.fechaVigencia ?? new Date();
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, 20);
  const minSim = opts.minSimilarity ?? DEFAULT_MIN_SIMILARITY;
  // Se piden MÁS filas de las que se entregan: el piso de similitud se aplica
  // en JS y antes se aplicaba sobre las `limit` primeras — una consulta cuyos
  // 6 vecinos más cercanos fueran débiles devolvía CERO aunque hubiera
  // artículos buenos en la posición 7. Cortar a `limit` después del piso.
  const candidatos = Math.min(limit * 4, 40);

  const vec = toVectorLiteral(await embedQuery(query, opts.cost ? { ...opts.cost, subtipo: "kb.embed_query" } : undefined));

  const fuenteFilter =
    opts.fuentes && opts.fuentes.length > 0
      ? Prisma.sql`AND d."source"::text IN (${Prisma.join(opts.fuentes)})`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<
    {
      documentId: string;
      articulo: string | null;
      contexto: string | null;
      texto: string;
      vigenciaDesde: Date;
      source: string;
      clave: string;
      titulo: string;
      url: string;
      publicadoDof: Date | null;
      similitud: number;
    }[]
  >`
    SELECT
      c."documentId", c."articulo", c."contexto", c."texto", c."vigenciaDesde",
      d."source"::text AS "source", d."clave", d."titulo", d."url", d."publicadoDof",
      1 - (c."embedding" <=> ${vec}::vector) AS "similitud"
    FROM "FiscalChunk" c
    JOIN "FiscalDocument" d ON d."id" = c."documentId"
    WHERE c."vigenciaDesde" <= ${fecha}
      AND (c."vigenciaHasta" IS NULL OR c."vigenciaHasta" >= ${fecha})
      ${fuenteFilter}
    ORDER BY c."embedding" <=> ${vec}::vector
    LIMIT ${candidatos}`;

  // A lo más 2 chunks por UNIDAD legal (artículo/regla; una guía entera es una
  // unidad): una guía larga no debe acaparar el top-6, pero dos artículos de la
  // misma ley nunca compiten entre sí (ver diversificar.ts).
  const resultados = diversificarPorUnidad(
    rows.filter((r) => r.similitud >= minSim),
    limit
  ).map((r) => ({
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
    }));

  const result: FiscalSearchResult = {
    resultados,
    fechaVigenciaConsultada: fecha.toISOString().slice(0, 10),
  };
  if (resultados.length === 0) {
    result.aviso =
      "Sin fundamento suficiente en el knowledge base para esta consulta. NO inventes un fundamento legal; dilo explícitamente y sugiere verificar con un contador.";
  }
  return result;
}
