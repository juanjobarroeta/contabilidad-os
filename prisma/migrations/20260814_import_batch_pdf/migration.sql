-- Evidencia del estado de cuenta: el documento original que respaldó la
-- importación por visión, con el resultado de su cuadre de saldos.
ALTER TABLE "ImportBatch"
  ADD COLUMN "archivoPdf" BYTEA,
  ADD COLUMN "archivoNombre" TEXT,
  ADD COLUMN "archivoMime" TEXT,
  ADD COLUMN "cuadro" BOOLEAN;
