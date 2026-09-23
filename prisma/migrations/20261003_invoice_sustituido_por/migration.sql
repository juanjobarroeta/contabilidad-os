-- CFDI sustituido (TipoRelacion 04): el UUID del comprobante vigente que lo
-- reemplaza. Los REPs sustituidos dejan de contar para impuestos y saldos.
-- Aditiva y nullable: la llena el cron cfdi-sustitucion-backfill.
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "sustituidoPorUuid" TEXT;
