-- CreateEnum
CREATE TYPE "PurifCompraEstado" AS ENUM ('PAGADA', 'PENDIENTE', 'CANCELADA');

-- AlterEnum
ALTER TYPE "PurifGastoCategoria" ADD VALUE 'ESTACIONAMIENTO';

-- CreateTable
CREATE TABLE "PurifInsumo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nombre" TEXT NOT NULL,
    "unidad" TEXT NOT NULL DEFAULT 'pieza',
    "categoria" "PurifGastoCategoria" NOT NULL DEFAULT 'FILTROS_INSUMOS',
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PurifInsumo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurifCompra" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "folio" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "supplierId" TEXT,
    "categoria" "PurifGastoCategoria" NOT NULL DEFAULT 'FILTROS_INSUMOS',
    "formaPago" "PurifFormaPago" NOT NULL,
    "estado" "PurifCompraEstado" NOT NULL DEFAULT 'PAGADA',
    "total" DOUBLE PRECISION NOT NULL,
    "notas" TEXT,
    "invoiceId" TEXT,
    "bankTransactionId" TEXT,
    "fechaPago" TIMESTAMP(3),
    "pagoFormaPago" "PurifFormaPago",

    CONSTRAINT "PurifCompra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurifCompraItem" (
    "id" TEXT NOT NULL,
    "compraId" TEXT NOT NULL,
    "insumoId" TEXT,
    "descripcion" TEXT NOT NULL,
    "cantidad" DOUBLE PRECISION NOT NULL,
    "precioUnitario" DOUBLE PRECISION NOT NULL,
    "importe" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PurifCompraItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurifInsumo_companyId_activo_idx" ON "PurifInsumo"("companyId", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "PurifInsumo_companyId_nombre_key" ON "PurifInsumo"("companyId", "nombre");

-- CreateIndex
CREATE UNIQUE INDEX "PurifCompra_bankTransactionId_key" ON "PurifCompra"("bankTransactionId");

-- CreateIndex
CREATE INDEX "PurifCompra_companyId_fecha_idx" ON "PurifCompra"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "PurifCompra_companyId_estado_idx" ON "PurifCompra"("companyId", "estado");

-- CreateIndex
CREATE INDEX "PurifCompra_companyId_supplierId_idx" ON "PurifCompra"("companyId", "supplierId");

-- CreateIndex
CREATE UNIQUE INDEX "PurifCompra_companyId_folio_key" ON "PurifCompra"("companyId", "folio");

-- CreateIndex
CREATE INDEX "PurifCompraItem_compraId_idx" ON "PurifCompraItem"("compraId");

-- AddForeignKey
ALTER TABLE "PurifInsumo" ADD CONSTRAINT "PurifInsumo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifCompra" ADD CONSTRAINT "PurifCompra_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifCompra" ADD CONSTRAINT "PurifCompra_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifCompra" ADD CONSTRAINT "PurifCompra_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifCompra" ADD CONSTRAINT "PurifCompra_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifCompraItem" ADD CONSTRAINT "PurifCompraItem_compraId_fkey" FOREIGN KEY ("compraId") REFERENCES "PurifCompra"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifCompraItem" ADD CONSTRAINT "PurifCompraItem_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "PurifInsumo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

