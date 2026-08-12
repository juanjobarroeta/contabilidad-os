-- Desglose de la nómina por persona: nombre y RFC del receptor del recibo.
ALTER TABLE "NominaCosto" ADD COLUMN IF NOT EXISTS "empleado" TEXT;
ALTER TABLE "NominaCosto" ADD COLUMN IF NOT EXISTS "rfcEmpleado" TEXT;
CREATE INDEX IF NOT EXISTS "NominaCosto_companyId_rfcEmpleado_idx" ON "NominaCosto"("companyId", "rfcEmpleado");
