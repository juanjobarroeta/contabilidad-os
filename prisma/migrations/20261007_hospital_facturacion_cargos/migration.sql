-- HospitalOS: facturar la cuenta del episodio desde el satélite. Cada cargo
-- sabe en qué prefactura va (mientras está PENDIENTE no entra a otra) y si
-- va a la factura global a público en general. Aditiva.
ALTER TABLE "HospCargo" ADD COLUMN IF NOT EXISTS "prefacturaId" TEXT;
ALTER TABLE "HospCargo" ADD COLUMN IF NOT EXISTS "publicoGeneral" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "HospCargo_prefacturaId_idx" ON "HospCargo"("prefacturaId");
DO $$ BEGIN
  ALTER TABLE "HospCargo" ADD CONSTRAINT "HospCargo_prefacturaId_fkey" FOREIGN KEY ("prefacturaId") REFERENCES "FacturaBorrador"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
