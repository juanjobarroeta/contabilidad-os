-- Índices en las llaves foráneas hacia Invoice.
--
-- Prisma crea índices de FK automáticamente en MySQL pero NO en PostgreSQL, así
-- que estas nueve tablas se recorrían enteras en cada búsqueda por factura. Se
-- notó cuando un diagnóstico sobre InvoiceItem llevaba 342 s sin terminar: el
-- LATERAL correlacionado hacía un seq scan de InvoiceItem POR CADA factura.
--
-- Afecta más de lo que parece:
--   • InvoiceItem  — toda la clasificación de conceptos y el reporte de cobertura.
--   • InvoiceTax   — el cálculo de IVA/ISR y retenciones agrupa por factura.
--   • VehiculoCosto— el EXISTS del reporte de cobertura.
--   • Todas        — el borrado en cascada de un Invoice también recorría la tabla.
CREATE INDEX IF NOT EXISTS "InvoiceItem_invoiceId_idx"     ON "InvoiceItem"("invoiceId");
CREATE INDEX IF NOT EXISTS "InvoiceTax_invoiceId_idx"      ON "InvoiceTax"("invoiceId");
CREATE INDEX IF NOT EXISTS "FacturaBorrador_invoiceId_idx" ON "FacturaBorrador"("invoiceId");
CREATE INDEX IF NOT EXISTS "BankTransaction_invoiceId_idx" ON "BankTransaction"("invoiceId");
CREATE INDEX IF NOT EXISTS "Estimacion_invoiceId_idx"      ON "Estimacion"("invoiceId");
CREATE INDEX IF NOT EXISTS "RestOrden_invoiceId_idx"       ON "RestOrden"("invoiceId");
CREATE INDEX IF NOT EXISTS "PurifVenta_invoiceId_idx"      ON "PurifVenta"("invoiceId");
CREATE INDEX IF NOT EXISTS "PurifCompra_invoiceId_idx"     ON "PurifCompra"("invoiceId");
CREATE INDEX IF NOT EXISTS "VehiculoCosto_invoiceId_idx"   ON "VehiculoCosto"("invoiceId");
