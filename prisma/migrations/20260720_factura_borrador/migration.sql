-- Prefacturas (borradores de CFDI en Facturapi) — aditivo.
CREATE TABLE "FacturaBorrador" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "draftId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "invoiceId" TEXT,
    "enviadaAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "FacturaBorrador_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FacturaBorrador_companyId_status_idx" ON "FacturaBorrador"("companyId", "status");

ALTER TABLE "FacturaBorrador" ADD CONSTRAINT "FacturaBorrador_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FacturaBorrador" ADD CONSTRAINT "FacturaBorrador_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
