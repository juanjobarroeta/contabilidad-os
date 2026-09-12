-- Normatividad de construcción (docs/MOTOR-JURIDICO.md, F3): NOM/NTC como fuente y
-- el municipio del ordenamiento cuando el ámbito es municipal.
ALTER TYPE "FiscalSource" ADD VALUE 'NOM';
ALTER TABLE "FiscalDocument" ADD COLUMN "municipio" TEXT;
