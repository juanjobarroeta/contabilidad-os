// ─────────────────────────────────────────────────────────────────────────────
// Resúmenes por unidad legal (Fase 2, experimento «el artículo correcto no
// está entre los candidatos»).
//
// El eval dijo que con rerank quedan ~30 fallos donde el artículo esperado no
// aparece ni entre los 40 vecinos del vector: el Art. 29-A CFF dice «los
// comprobantes fiscales digitales… deberán contener los siguientes requisitos»
// y el cliente pregunta «¿qué datos debe llevar mi factura?». El embedding del
// texto legal no se parece a la pregunta cotidiana.
//
// Solución: por cada unidad (artículo / regla) un resumen de 2–3 líneas
// generado UNA vez con un modelo barato — de qué trata y qué preguntas
// cotidianas responde — embebido como chunk extra de la misma unidad
// (`parte = 0`, mismo `articulo`). En la búsqueda, un resumen que entra al
// top-k se SUSTITUYE por la mejor parte real del artículo (search.ts), así el
// agente siempre ve texto legal, nunca el resumen. De paso el mismo llamado
// etiqueta `regimenes` (pendiente de la Fase 1).
//
// Idempotente e incremental: sólo unidades vigentes sin resumen. Un refresh
// con force borra los chunks (y los resúmenes); este job los repone.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { meteredCreate } from "@/lib/costos/anthropic";
import { embedTexts, toVectorLiteral } from "./embed";
import { buildCita } from "./search";

export const RESUMEN_MODEL = process.env.AI_RESUMEN_MODEL ?? "claude-haiku-4-5-20251001";
/** Caracteres del texto de la unidad que ve el modelo (todas las partes, en orden). */
const TEXTO_MAX = 6000;
const REGIMENES_VALIDOS = new Set(["601", "603", "605", "606", "608", "610", "611", "612", "614", "616", "620", "621", "622", "623", "624", "625", "626"]);

export interface UnidadSinResumen {
  documentId: string;
  articulo: string;
  source: string;
  clave: string;
  titulo: string;
  contexto: string | null;
  vigenciaDesde: Date;
  texto: string;
}

export interface ResumenGenerado {
  resumen: string;
  preguntas: string[];
  regimenes: string[];
}

const SYSTEM = `Eres un fiscalista mexicano que explica la ley a dueños de negocio. Recibes un artículo de ley/reglamento o una regla de la RMF. Devuelve ÚNICAMENTE JSON con:
- "resumen": 2–3 líneas, en español llano, de QUÉ trata y qué obliga/permite (sin repetir el número del artículo).
- "preguntas": 3 a 5 preguntas cotidianas, tal como las haría un cliente o su contador, que este texto responde («¿qué datos debe llevar mi factura?», «¿puedo deducir la gasolina si pagué en efectivo?»).
- "regimenes": claves SAT de los regímenes a los que aplica de forma específica (601 general PM, 626 RESICO, 612 PF actividad empresarial, 605 sueldos, 621 incorporación, 616 sin obligaciones…); lista vacía si aplica a todos.
Sin explicaciones fuera del JSON.`;

/** Parsea la respuesta del modelo; null si no es usable. Puro y testeable. */
export function parsearResumen(texto: string): ResumenGenerado | null {
  const m = texto.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j: unknown;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const resumen = typeof o.resumen === "string" ? o.resumen.trim() : "";
  if (resumen.length < 20) return null;
  const preguntas = Array.isArray(o.preguntas) ? o.preguntas.filter((p): p is string => typeof p === "string" && p.trim().length > 5).map((p) => p.trim()).slice(0, 6) : [];
  const regimenes = Array.isArray(o.regimenes) ? o.regimenes.map(String).map((r) => r.trim()).filter((r) => REGIMENES_VALIDOS.has(r)) : [];
  return { resumen, preguntas, regimenes };
}

/** Texto del chunk-resumen (lo que se embebe). Puro y testeable. */
export function textoResumen(cita: string, contexto: string | null, r: ResumenGenerado): string {
  const prefijo = contexto ? `[${contexto}]\n` : "";
  const preguntas = r.preguntas.length > 0 ? `\nResponde a: ${r.preguntas.join(" · ")}` : "";
  return `${prefijo}[Resumen · ${cita}]\n${r.resumen}${preguntas}`;
}

/** Unidades vigentes (artículo/regla) sin chunk-resumen, con su texto concatenado. */
export async function unidadesSinResumen(limit: number): Promise<UnidadSinResumen[]> {
  return prisma.$queryRaw<UnidadSinResumen[]>`
    SELECT u."documentId", u."articulo", d."source"::text AS "source", d."clave", d."titulo",
      u."contexto", u."vigenciaDesde", u."texto"
    FROM (
      SELECT c."documentId", c."articulo", MIN(c."contexto") AS "contexto", MIN(c."vigenciaDesde") AS "vigenciaDesde",
        string_agg(c."texto", E'\n' ORDER BY c."parte" NULLS FIRST) AS "texto"
      FROM "FiscalChunk" c
      WHERE c."articulo" IS NOT NULL AND c."articulo" <> 'TRANSITORIOS'
        AND (c."parte" IS NULL OR c."parte" > 0)
        AND c."vigenciaHasta" IS NULL
      GROUP BY c."documentId", c."articulo"
    ) u
    JOIN "FiscalDocument" d ON d."id" = u."documentId"
    WHERE d."source"::text IN ('LEY', 'REGLAMENTO', 'RMF')
      AND NOT EXISTS (
        SELECT 1 FROM "FiscalChunk" r
        WHERE r."documentId" = u."documentId" AND r."articulo" = u."articulo" AND r."parte" = 0
      )
    ORDER BY d."clave", u."articulo"
    LIMIT ${limit}`;
}

export async function contarSinResumen(): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n
    FROM (
      SELECT c."documentId", c."articulo"
      FROM "FiscalChunk" c
      JOIN "FiscalDocument" d ON d."id" = c."documentId"
      WHERE c."articulo" IS NOT NULL AND c."articulo" <> 'TRANSITORIOS'
        AND (c."parte" IS NULL OR c."parte" > 0) AND c."vigenciaHasta" IS NULL
        AND d."source"::text IN ('LEY', 'REGLAMENTO', 'RMF')
      GROUP BY c."documentId", c."articulo"
    ) u
    WHERE NOT EXISTS (
      SELECT 1 FROM "FiscalChunk" r WHERE r."documentId" = u."documentId" AND r."articulo" = u."articulo" AND r."parte" = 0
    )`;
  return Number(rows[0]?.n ?? 0);
}

async function resumirUnidad(client: Anthropic, u: UnidadSinResumen): Promise<ResumenGenerado | null> {
  const cita = buildCita(u.source, u.clave, u.articulo, u.titulo);
  // El texto de las partes ya trae el breadcrumb y, en las partes 2+, el
  // encabezado repetido; se manda tal cual, recortado.
  const cuerpo = u.texto.length > TEXTO_MAX ? `${u.texto.slice(0, TEXTO_MAX)}\n[… recortado]` : u.texto;
  const msg = await meteredCreate(
    client,
    { companyId: null, subtipo: "kb.resumen" },
    {
      model: RESUMEN_MODEL,
      max_tokens: 500,
      system: SYSTEM,
      messages: [{ role: "user", content: `${cita} (${u.titulo})\n\n${cuerpo}` }],
    }
  );
  const texto = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parsearResumen(texto);
}

async function conConcurrencia<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const k = i++;
        if (k >= items.length) return;
        out[k] = await fn(items[k]);
      }
    })
  );
  return out;
}

export interface ResultadoResumenes {
  procesadas: number;
  insertadas: number;
  fallidas: string[];
  restantes: number;
  ms: number;
}

/**
 * Genera e inserta resúmenes para hasta `limit` unidades sin resumen.
 * Cada llamada es corta (cabe en maxDuration); el workflow repite hasta
 * `restantes = 0`.
 */
export async function generarResumenes(opts: { limit?: number; concurrencia?: number } = {}): Promise<ResultadoResumenes> {
  const t0 = Date.now();
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 200);
  const concurrencia = Math.min(Math.max(1, opts.concurrencia ?? 8), 16);
  const client = new Anthropic();
  const unidades = await unidadesSinResumen(limit);

  const generados = await conConcurrencia(unidades, concurrencia, async (u) => {
    try {
      return await resumirUnidad(client, u);
    } catch (err) {
      console.error("[kb.resumen]", u.clave, u.articulo, err instanceof Error ? err.message : err);
      return null;
    }
  });

  const listos = unidades
    .map((u, i) => ({ u, r: generados[i] }))
    .filter((x): x is { u: UnidadSinResumen; r: ResumenGenerado } => x.r !== null);
  const fallidas = unidades.filter((_, i) => generados[i] === null).map((u) => `${u.clave} ${u.articulo}`);

  const textos = listos.map(({ u, r }) => textoResumen(buildCita(u.source, u.clave, u.articulo, u.titulo), u.contexto, r));
  const embeddings = textos.length > 0 ? await embedTexts(textos, { companyId: null, subtipo: "kb.resumen.embed" }) : [];

  let insertadas = 0;
  for (let i = 0; i < listos.length; i++) {
    const { u, r } = listos[i];
    await prisma.$executeRaw`
      INSERT INTO "FiscalChunk"
        ("id", "documentId", "articulo", "parte", "contexto", "texto", "embedding", "vigenciaDesde", "vigenciaHasta", "regimenes")
      VALUES
        (${randomUUID()}, ${u.documentId}, ${u.articulo}, 0, ${u.contexto}, ${textos[i]},
         ${toVectorLiteral(embeddings[i])}::vector, ${u.vigenciaDesde}, NULL, ${Prisma.sql`ARRAY[${Prisma.join(r.regimenes.length > 0 ? r.regimenes : [""])}]::text[]`})`;
    insertadas++;
  }
  // ARRAY[''] cuando no hay regímenes: un solo elemento vacío. Se limpia aquí
  // porque Prisma.join no acepta listas vacías.
  if (insertadas > 0) {
    await prisma.$executeRaw`UPDATE "FiscalChunk" SET "regimenes" = '{}' WHERE "parte" = 0 AND "regimenes" = ARRAY['']::text[]`;
  }

  return { procesadas: unidades.length, insertadas, fallidas, restantes: await contarSinResumen(), ms: Date.now() - t0 };
}
