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

export interface UpsertDocumentInput {
  source: FiscalSource;
  clave: string;
  titulo: string;
  url: string;
  publicadoDof: Date | null;
  vigenciaDesde: Date;
  cleanText: string; // hashed for change detection
  chunks: LawChunk[];
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

export async function upsertFiscalDocument(input: UpsertDocumentInput): Promise<UpsertResult> {
  const hash = createHash("sha256").update(input.cleanText).digest("hex");

  const latest = await prisma.fiscalDocument.findFirst({
    where: { clave: input.clave },
    orderBy: { vigenciaDesde: "desc" },
  });
  if (latest?.hash === hash) {
    return { skipped: true, documentId: latest.id };
  }
  if (latest && latest.vigenciaDesde >= input.vigenciaDesde) {
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
      if (latest && latest.vigenciaHasta === null) {
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
          ("id", "source", "clave", "titulo", "url", "publicadoDof", "vigenciaDesde", "vigenciaHasta", "hash", "createdAt")
        VALUES
          (${documentId}, ${input.source}::"FiscalSource", ${input.clave}, ${input.titulo}, ${input.url},
           ${input.publicadoDof}, ${input.vigenciaDesde}, NULL, ${hash}, NOW())`;

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

  return { skipped: false, documentId, chunkCount: input.chunks.length, closedPreviousVersion };
}
