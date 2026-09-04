-- Invoice.customerId no tenía índice: cualquier filtro "facturas de este
-- cliente" (estado de cuenta, proveedores puros, saldos) barría la tabla
-- entera por cada Customer. Con 13k CFDIs, GET /api/clientes tardaba 7–25 s.
CREATE INDEX IF NOT EXISTS "Invoice_customerId_idx" ON "Invoice"("customerId");
