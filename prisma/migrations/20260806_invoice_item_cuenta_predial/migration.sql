-- Cuenta predial del inmueble arrendado (CFDI 4.0: nodo hijo CuentaPredial del
-- concepto). Aditiva y nullable: los conceptos existentes quedan intactos.
ALTER TABLE "InvoiceItem" ADD COLUMN IF NOT EXISTS "cuentaPredial" TEXT;
