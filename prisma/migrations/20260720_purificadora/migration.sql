-- CreateEnum
CREATE TYPE "PurifFormaPago" AS ENUM ('EFECTIVO', 'TRANSFERENCIA', 'TARJETA', 'CREDITO');

-- CreateEnum
CREATE TYPE "PurifVentaEstado" AS ENUM ('COBRADA', 'PENDIENTE', 'CANCELADA');

-- CreateEnum
CREATE TYPE "PurifGastoCategoria" AS ENUM ('AGUA_CRUDA', 'ELECTRICIDAD', 'FILTROS_INSUMOS', 'MANTENIMIENTO', 'SUELDOS', 'RENTA', 'COMBUSTIBLE', 'OTRO');

-- AlterEnum
ALTER TYPE "EntrySource" ADD VALUE 'PURIFICADORA';

-- AlterEnum
ALTER TYPE "ModuloApp" ADD VALUE 'PURIFICADORA';

-- CreateTable
CREATE TABLE "PurifConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombreComercial" TEXT,
    "precioGarrafon" DOUBLE PRECISION NOT NULL DEFAULT 15,
    "ivaTasaDefault" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "PurifConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurifProducto" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT NOT NULL,
    "precio" DOUBLE PRECISION NOT NULL,
    "garrafones" INTEGER NOT NULL DEFAULT 1,
    "ivaTasa" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PurifProducto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurifVenta" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "folio" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT,
    "formaPago" "PurifFormaPago" NOT NULL,
    "estado" "PurifVentaEstado" NOT NULL DEFAULT 'COBRADA',
    "subtotal" DOUBLE PRECISION NOT NULL,
    "iva" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL,
    "garrafones" INTEGER NOT NULL DEFAULT 0,
    "fechaCobro" TIMESTAMP(3),
    "cobroFormaPago" "PurifFormaPago",
    "notas" TEXT,
    "invoiceId" TEXT,
    "bankTransactionId" TEXT,

    CONSTRAINT "PurifVenta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurifVentaItem" (
    "id" TEXT NOT NULL,
    "ventaId" TEXT NOT NULL,
    "productoId" TEXT,
    "descripcion" TEXT NOT NULL,
    "cantidad" DOUBLE PRECISION NOT NULL,
    "precioUnitario" DOUBLE PRECISION NOT NULL,
    "importe" DOUBLE PRECISION NOT NULL,
    "garrafones" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PurifVentaItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurifGasto" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "categoria" "PurifGastoCategoria" NOT NULL,
    "descripcion" TEXT NOT NULL,
    "monto" DOUBLE PRECISION NOT NULL,
    "formaPago" "PurifFormaPago" NOT NULL DEFAULT 'EFECTIVO',
    "supplierId" TEXT,
    "notas" TEXT,
    "bankTransactionId" TEXT,

    CONSTRAINT "PurifGasto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurifConfig_companyId_key" ON "PurifConfig"("companyId");

-- CreateIndex
CREATE INDEX "PurifProducto_companyId_activo_idx" ON "PurifProducto"("companyId", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "PurifProducto_companyId_nombre_key" ON "PurifProducto"("companyId", "nombre");

-- CreateIndex
CREATE UNIQUE INDEX "PurifVenta_bankTransactionId_key" ON "PurifVenta"("bankTransactionId");

-- CreateIndex
CREATE INDEX "PurifVenta_companyId_fecha_idx" ON "PurifVenta"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "PurifVenta_companyId_estado_idx" ON "PurifVenta"("companyId", "estado");

-- CreateIndex
CREATE INDEX "PurifVenta_companyId_customerId_idx" ON "PurifVenta"("companyId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "PurifVenta_companyId_folio_key" ON "PurifVenta"("companyId", "folio");

-- CreateIndex
CREATE INDEX "PurifVentaItem_ventaId_idx" ON "PurifVentaItem"("ventaId");

-- CreateIndex
CREATE UNIQUE INDEX "PurifGasto_bankTransactionId_key" ON "PurifGasto"("bankTransactionId");

-- CreateIndex
CREATE INDEX "PurifGasto_companyId_fecha_idx" ON "PurifGasto"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "PurifGasto_companyId_categoria_idx" ON "PurifGasto"("companyId", "categoria");

-- AddForeignKey
ALTER TABLE "PurifConfig" ADD CONSTRAINT "PurifConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifProducto" ADD CONSTRAINT "PurifProducto_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifVenta" ADD CONSTRAINT "PurifVenta_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifVenta" ADD CONSTRAINT "PurifVenta_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifVenta" ADD CONSTRAINT "PurifVenta_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifVenta" ADD CONSTRAINT "PurifVenta_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifVentaItem" ADD CONSTRAINT "PurifVentaItem_ventaId_fkey" FOREIGN KEY ("ventaId") REFERENCES "PurifVenta"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifVentaItem" ADD CONSTRAINT "PurifVentaItem_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "PurifProducto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifGasto" ADD CONSTRAINT "PurifGasto_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifGasto" ADD CONSTRAINT "PurifGasto_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifGasto" ADD CONSTRAINT "PurifGasto_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

