-- HospitalOS: la tasa con la que se parte el IVA del depósito sin CFDI de
-- anticipo, y la liga del depósito con su CFDI de anticipo. Aditiva.
ALTER TABLE "HospConfig" ADD COLUMN IF NOT EXISTS "ivaAnticiposTasa" DECIMAL(18,6);
ALTER TABLE "HospDeposito" ADD COLUMN IF NOT EXISTS "invoiceAnticipoId" TEXT;
CREATE INDEX IF NOT EXISTS "HospDeposito_invoiceAnticipoId_idx" ON "HospDeposito"("invoiceAnticipoId");
DO $$ BEGIN
  ALTER TABLE "HospDeposito" ADD CONSTRAINT "HospDeposito_invoiceAnticipoId_fkey" FOREIGN KEY ("invoiceAnticipoId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
