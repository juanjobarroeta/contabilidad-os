-- Caja: cada cobro dice si va amparado por un CFDI propio (CON_CFDI) o si sus
-- cargos van a la factura global (SIN_CFDI). Aditiva: los cobros existentes
-- quedan CON_CFDI, que es lo que la caja capturaba (siempre contra factura).
DO $$ BEGIN
  CREATE TYPE "HospCobroCfdi" AS ENUM ('CON_CFDI', 'SIN_CFDI');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "HospCobro" ADD COLUMN IF NOT EXISTS "cfdi" "HospCobroCfdi" NOT NULL DEFAULT 'CON_CFDI';
ALTER TABLE "HospCargo" ADD COLUMN IF NOT EXISTS "publicoGeneralCobroId" TEXT;
CREATE INDEX IF NOT EXISTS "HospCargo_publicoGeneralCobroId_idx" ON "HospCargo"("publicoGeneralCobroId");
