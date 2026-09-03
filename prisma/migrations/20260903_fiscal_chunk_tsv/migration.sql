-- Brazo léxico de la búsqueda fiscal (Fase 2 del copiloto): tsvector en
-- español sobre número de artículo + texto.
--
-- Columna normal mantenida por TRIGGER, no columna GENERATED: Prisma modela
-- la generada como DEFAULT (db push en CI la crea como DEFAULT y Postgres
-- rechaza referencias a columnas ahí). El trigger es invisible para Prisma,
-- así que el schema sólo declara `tsv tsvector?` y no hay drift. La ingesta
-- (INSERT crudo en upsert.ts) no tiene que calcular nada.
ALTER TABLE "FiscalChunk" ADD COLUMN "tsv" tsvector;

CREATE OR REPLACE FUNCTION fiscal_chunk_tsv_actualizar() RETURNS trigger AS $$
BEGIN
  NEW."tsv" := to_tsvector('spanish', coalesce(NEW."articulo", '') || ' ' || NEW."texto");
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER fiscal_chunk_tsv
  BEFORE INSERT OR UPDATE OF "articulo", "texto" ON "FiscalChunk"
  FOR EACH ROW EXECUTE FUNCTION fiscal_chunk_tsv_actualizar();

-- Chunks ya existentes.
UPDATE "FiscalChunk" SET "tsv" = to_tsvector('spanish', coalesce("articulo", '') || ' ' || "texto");

CREATE INDEX "FiscalChunk_tsv_idx" ON "FiscalChunk" USING GIN ("tsv");
