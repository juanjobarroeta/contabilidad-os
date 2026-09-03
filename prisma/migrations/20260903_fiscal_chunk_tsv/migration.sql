-- Brazo léxico de la búsqueda fiscal (Fase 2 del copiloto): tsvector en
-- español sobre número de artículo + texto, como columna GENERADA para que la
-- ingesta (INSERT crudo en upsert.ts) no tenga que calcularla.
ALTER TABLE "FiscalChunk"
  ADD COLUMN "tsv" tsvector GENERATED ALWAYS AS (
    to_tsvector('spanish', coalesce("articulo", '') || ' ' || "texto")
  ) STORED;

CREATE INDEX "FiscalChunk_tsv_idx" ON "FiscalChunk" USING GIN ("tsv");
