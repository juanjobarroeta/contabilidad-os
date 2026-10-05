-- Marcador «ya se leyó el nodo Impuestos del XML». La etapa de desglose del
-- alta contaba sólo facturas con filas de impuesto; nómina, pagos y traslados
-- nunca las tienen y el alta se quedaba cargando para siempre. Las filas que
-- ya tienen desglose se marcan aquí mismo; el resto las marca el cron
-- invoice-taxes-backfill al leerlas (con o sin impuestos).
ALTER TABLE "Invoice" ADD COLUMN IF NOT EXISTS "impuestosParsedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Invoice_companyId_impuestosParsedAt_idx" ON "Invoice"("companyId", "impuestosParsedAt");
UPDATE "Invoice" i SET "impuestosParsedAt" = now()
WHERE i."impuestosParsedAt" IS NULL
  AND EXISTS (SELECT 1 FROM "InvoiceTax" t WHERE t."invoiceId" = i.id);
