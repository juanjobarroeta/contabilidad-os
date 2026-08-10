-- CreateTable
CREATE TABLE "ServicioVenta" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clienteId" TEXT,
    "vehiculoId" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "manoObra" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "refacciones" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "concepto" TEXT,

    CONSTRAINT "ServicioVenta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServicioVenta_invoiceId_key" ON "ServicioVenta"("invoiceId");

-- CreateIndex
CREATE INDEX "ServicioVenta_companyId_fecha_idx" ON "ServicioVenta"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "ServicioVenta_companyId_clienteId_idx" ON "ServicioVenta"("companyId", "clienteId");

-- AddForeignKey
ALTER TABLE "ServicioVenta" ADD CONSTRAINT "ServicioVenta_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicioVenta" ADD CONSTRAINT "ServicioVenta_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicioVenta" ADD CONSTRAINT "ServicioVenta_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServicioVenta" ADD CONSTRAINT "ServicioVenta_vehiculoId_fkey" FOREIGN KEY ("vehiculoId") REFERENCES "Vehiculo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

