-- CreateEnum
CREATE TYPE "VehiculoCfdiRol" AS ENUM ('COMPRA', 'VENTA', 'COSTO', 'NOTA_CREDITO', 'SUSTITUIDA', 'DUPLICADA', 'SERVICIO');

-- CreateTable
CREATE TABLE "VehiculoCfdi" (
    "id" TEXT NOT NULL,
    "vehiculoId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "rol" "VehiculoCfdiRol" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehiculoCfdi_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VehiculoCfdi_invoiceId_idx" ON "VehiculoCfdi"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "VehiculoCfdi_vehiculoId_invoiceId_key" ON "VehiculoCfdi"("vehiculoId", "invoiceId");

-- AddForeignKey
ALTER TABLE "VehiculoCfdi" ADD CONSTRAINT "VehiculoCfdi_vehiculoId_fkey" FOREIGN KEY ("vehiculoId") REFERENCES "Vehiculo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehiculoCfdi" ADD CONSTRAINT "VehiculoCfdi_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

