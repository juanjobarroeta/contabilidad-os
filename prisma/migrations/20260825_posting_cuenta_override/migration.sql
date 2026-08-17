-- Fase 1 del motor al plan propio: la inversión codAgrup → cuenta propia
-- resuelve sola cuando hay UNA candidata; cuando hay varias (los agrupadores
-- de gasto existen por departamento) el contador decide una vez y queda aquí.
CREATE TABLE "PostingCuentaOverride" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "codigoMotor" TEXT NOT NULL,
    "chartAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostingCuentaOverride_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PostingCuentaOverride_companyId_codigoMotor_key"
    ON "PostingCuentaOverride"("companyId", "codigoMotor");
ALTER TABLE "PostingCuentaOverride" ADD CONSTRAINT "PostingCuentaOverride_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PostingCuentaOverride" ADD CONSTRAINT "PostingCuentaOverride_chartAccountId_fkey"
    FOREIGN KEY ("chartAccountId") REFERENCES "ChartAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ChartAccount_companyId_codAgrup_idx" ON "ChartAccount"("companyId", "codAgrup");
