-- Vista operador: monitoreo de la descarga de CE del SAT (worker Playwright).
-- Columnas ADITIVAS y NULLABLE — no tocan datos existentes.
ALTER TABLE "Company" ADD COLUMN "ceSatSyncEn" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "ceSatSyncOk" BOOLEAN;
ALTER TABLE "Company" ADD COLUMN "ceSatSyncNuevos" INTEGER;
ALTER TABLE "Company" ADD COLUMN "ceSatSyncInfo" TEXT;
