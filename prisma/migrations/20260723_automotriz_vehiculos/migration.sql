-- CreateEnum
CREATE TYPE "VehiculoTipo" AS ENUM ('NUEVO', 'SEMINUEVO');

-- CreateEnum
CREATE TYPE "VehiculoEstado" AS ENUM ('EN_TRANSITO', 'DISPONIBLE', 'APARTADO', 'VENDIDO', 'ENTREGADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "VehiculoCostoTipo" AS ENUM ('INTERES_PISO', 'ACONDICIONAMIENTO', 'TRASLADO', 'ACCESORIOS', 'OTRO');

-- AlterEnum
ALTER TYPE "ModuloApp" ADD VALUE 'AUTOMOTRIZ';

-- AlterEnum
ALTER TYPE "EntrySource" ADD VALUE 'AUTOMOTRIZ';

-- CreateTable
CREATE TABLE "Vehiculo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "vin" TEXT NOT NULL,
    "marca" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "version" TEXT,
    "anio" INTEGER NOT NULL,
    "color" TEXT,
    "numeroEconomico" TEXT,
    "tipo" "VehiculoTipo" NOT NULL DEFAULT 'NUEVO',
    "estado" "VehiculoEstado" NOT NULL DEFAULT 'EN_TRANSITO',
    "kilometraje" INTEGER,
    "costoCompra" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fechaCompra" TIMESTAMP(3),
    "compraInvoiceId" TEXT,
    "supplierId" TEXT,
    "planPisoTasaAnual" DOUBLE PRECISION,
    "planPisoInicio" TIMESTAMP(3),
    "precioLista" DOUBLE PRECISION,
    "precioVenta" DOUBLE PRECISION,
    "isan" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fechaVenta" TIMESTAMP(3),
    "ventaInvoiceId" TEXT,
    "clienteId" TEXT,
    "vendedorId" TEXT,
    "comisionMonto" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notas" TEXT,

    CONSTRAINT "Vehiculo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehiculoCosto" (
    "id" TEXT NOT NULL,
    "vehiculoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo" "VehiculoCostoTipo" NOT NULL,
    "concepto" TEXT NOT NULL,
    "monto" DOUBLE PRECISION NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "invoiceId" TEXT,

    CONSTRAINT "VehiculoCosto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Vehiculo_companyId_estado_idx" ON "Vehiculo"("companyId", "estado");

-- CreateIndex
CREATE INDEX "Vehiculo_companyId_tipo_estado_idx" ON "Vehiculo"("companyId", "tipo", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "Vehiculo_companyId_vin_key" ON "Vehiculo"("companyId", "vin");

-- CreateIndex
CREATE INDEX "VehiculoCosto_vehiculoId_tipo_idx" ON "VehiculoCosto"("vehiculoId", "tipo");

-- AddForeignKey
ALTER TABLE "Vehiculo" ADD CONSTRAINT "Vehiculo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehiculo" ADD CONSTRAINT "Vehiculo_compraInvoiceId_fkey" FOREIGN KEY ("compraInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehiculo" ADD CONSTRAINT "Vehiculo_ventaInvoiceId_fkey" FOREIGN KEY ("ventaInvoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehiculo" ADD CONSTRAINT "Vehiculo_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehiculo" ADD CONSTRAINT "Vehiculo_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehiculo" ADD CONSTRAINT "Vehiculo_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehiculoCosto" ADD CONSTRAINT "VehiculoCosto_vehiculoId_fkey" FOREIGN KEY ("vehiculoId") REFERENCES "Vehiculo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehiculoCosto" ADD CONSTRAINT "VehiculoCosto_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

