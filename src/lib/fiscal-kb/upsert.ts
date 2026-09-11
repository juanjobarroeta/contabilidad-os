// Vigencia-aware versioned upsert for fiscal documents. Never overwrites: a
// new version of the same clave CLOSES the prior one (vigenciaHasta) and
// inserts fresh chunks, preserving history so period-specific questions can
// retrieve the law in force at that time.
//
// Design doc: docs/FISCAL-KNOWLEDGE-BASE.md §4–6.

import { createHash, randomUUID } from "crypto";
import { Prisma, FiscalSource } from "@prisma/client";
import { prisma } from "../prisma";
import { LawChunk } from "./chunk";
import { embedTexts, toVectorLiteral } from "./embed";
import type { Ambito } from "./materias";

export interface UpsertDocumentInput {
  source: FiscalSource;
  clave: string;
  titulo: string;
  url: string;
  publicadoDof: Date | null;
  vigenciaDesde: Date;
  cleanText: string; // hashed for change detection
  chunks: LawChunk[];
  /** Materias del ordenamiento (docs/MOTOR-JURIDICO.md §3.1). Obligatorio y no vacío:
   *  un documento sin materias no lo vería ningún alcance y eso es un bug, no un default. */
  materias: string[];
  ambito: Ambito;
  entidad?: string | null;
  /** Replace all existing versions of this clave even if the hash is unchanged.
   *  Use after a chunker/embedding change, where the source text is identical
   *  but the chunks differ (a normal upsert would hash-skip). */
  force?: boolean;
}

export interface UpsertResult {
  skipped: boolean;
  documentId?: string;
  chunkCount?: number;
  closedPreviousVersion?: boolean;
}

function dayBefore(d: Date): Date {
  return new Date(d.getTime() - 24 * 60 * 60 * 1000);
}

/**
 * Las materias, el ámbito y la entidad son del ORDENAMIENTO, no de la versión:
 * se sincronizan en todas las versiones de la clave en cada ingesta, también
 * cuando el texto no cambió (así una corrección del catálogo llega a la base
 * en el siguiente refresco sin re-embeber nada).
 */
async function sincronizarMetadatos(input: UpsertDocumentInput): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "FiscalDocument"
    SET "materias" = ${input.materias}::text[], "ambito" = ${input.ambito}::"AmbitoJuridico", "entidad" = ${input.entidad ?? null}
    WHERE "clave" = ${input.clave}
      AND ("materias" IS DISTINCT FROM ${input.materias}::text[] OR "ambito" IS DISTINCT FROM ${input.ambito}::"AmbitoJuridico" OR "entidad" IS DISTINCT FROM ${input.entidad ?? null})`;
}

export async function upsertFiscalDocument(input: UpsertDocumentInput): Promise<UpsertResult> {
  if (!Array.isArray(input.materias) || input.materias.length === 0) {
    throw new Error(`${input.clave}: la ingesta exige al menos una materia (ver src/lib/fiscal-kb/materias.ts).`);
  }
  const hash = createHash("sha256").update(input.cleanText).digest("hex");

  const latest = await prisma.fiscalDocument.findFirst({
    where: { clave: input.clave },
    orderBy: { vigenciaDesde: "desc" },
  });
  if (!input.force && latest?.hash === hash) {
    await sincronizarMetadatos(input);
    return { skipped: true, documentId: latest.id };
  }
  if (!input.force && latest && latest.vigenciaDesde >= input.vigenciaDesde) {
    throw new Error(
      `${input.clave}: la versión nueva (vigencia ${input.vigenciaDesde.toISOString().slice(0, 10)}) no es posterior a la almacenada (${latest.vigenciaDesde.toISOString().slice(0, 10)}) pero el contenido cambió — revisa la fuente antes de ingerir.`
    );
  }

  // Embed before opening the transaction — slow network work stays outside.
  const embeddings = await embedTexts(input.chunks.map((c) => c.texto));

  let closedPreviousVersion = false;
  const documentId = randomUUID();

  await prisma.$transaction(
    async (tx) => {
      if (input.force) {
        // Clean replacement: drop every prior version of this clave (chunks
        // cascade) so a re-chunk doesn't leave stale historical versions.
        await tx.fiscalDocument.deleteMany({ where: { clave: input.clave } });
      } else if (latest && latest.vigenciaHasta === null) {
        await tx.fiscalDocument.update({
          where: { id: latest.id },
          data: { vigenciaHasta: dayBefore(input.vigenciaDesde) },
        });
        await tx.$executeRaw`
          UPDATE "FiscalChunk" SET "vigenciaHasta" = ${dayBefore(input.vigenciaDesde)}
          WHERE "documentId" = ${latest.id} AND "vigenciaHasta" IS NULL`;
        closedPreviousVersion = true;
      }

      // FiscalChunk has a required Unsupported(vector) column, so Prisma
      // Client can't create rows — document + chunks go in via raw SQL.
      await tx.$executeRaw`
        INSERT INTO "FiscalDocument"
          ("id", "source", "clave", "titulo", "url", "publicadoDof", "vigenciaDesde", "vigenciaHasta", "hash", "createdAt",
           "materias", "ambito", "entidad")
        VALUES
          (${documentId}, ${input.source}::"FiscalSource", ${input.clave}, ${input.titulo}, ${input.url},
           ${input.publicadoDof}, ${input.vigenciaDesde}, NULL, ${hash}, NOW(),
           ${input.materias}::text[], ${input.ambito}::"AmbitoJuridico", ${input.entidad ?? null})`;

      for (let i = 0; i < input.chunks.length; i++) {
        const c = input.chunks[i];
        await tx.$executeRaw`
          INSERT INTO "FiscalChunk"
            ("id", "documentId", "articulo", "parte", "contexto", "texto", "embedding", "vigenciaDesde", "vigenciaHasta", "regimenes")
          VALUES
            (${randomUUID()}, ${documentId}, ${c.articulo}, ${c.parte}, ${c.contexto}, ${c.texto},
             ${toVectorLiteral(embeddings[i])}::vector, ${input.vigenciaDesde}, NULL, ${Prisma.sql`'{}'`})`;
      }
    },
    { timeout: 120_000 } // ~300+ chunk inserts for a full ley
  );

  // Versiones anteriores que sigan abiertas por historia también llevan las
  // materias nuevas (la clave es la misma).
  await sincronizarMetadatos(input);

  return { skipped: false, documentId, chunkCount: input.chunks.length, closedPreviousVersion };
}
