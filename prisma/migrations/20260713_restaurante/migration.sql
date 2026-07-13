-- CreateEnum
CREATE TYPE "RestUnidad" AS ENUM ('KG', 'G', 'L', 'ML', 'PZA');

-- CreateEnum
CREATE TYPE "RestCompraEstado" AS ENUM ('BORRADOR', 'ORDENADA', 'RECIBIDA', 'PAGADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "RestFormaPago" AS ENUM ('EFECTIVO', 'TRANSFERENCIA', 'TARJETA');

-- CreateEnum
CREATE TYPE "RestEstacion" AS ENUM ('COCINA', 'BARRA', 'POSTRES');

-- CreateEnum
CREATE TYPE "RestOrdenTipo" AS ENUM ('MESA', 'LLEVAR', 'DOMICILIO');

-- CreateEnum
CREATE TYPE "RestOrdenEstado" AS ENUM ('ABIERTA', 'COBRADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "RestItemEstado" AS ENUM ('PENDIENTE', 'EN_PREPARACION', 'LISTO', 'ENTREGADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "RestOrdenFormaPago" AS ENUM ('EFECTIVO', 'TRANSFERENCIA', 'TARJETA', 'CORTESIA');

-- AlterEnum
ALTER TYPE "ModuloApp" ADD VALUE 'RESTAURANTE';

-- AlterEnum
ALTER TYPE "EntrySource" ADD VALUE 'RESTAURANTE';

-- CreateTable
CREATE TABLE "RestauranteConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ivaRate" DOUBLE PRECISION NOT NULL DEFAULT 0.16,
    "numMesas" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "RestauranteConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestInsumo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT NOT NULL,
    "categoria" TEXT,
    "unidad" "RestUnidad" NOT NULL DEFAULT 'PZA',
    "costoPromedio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stockMinimo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RestInsumo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestCompra" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "folio" TEXT NOT NULL,
    "supplierId" TEXT,
    "estado" "RestCompraEstado" NOT NULL DEFAULT 'ORDENADA',
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "iva" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notas" TEXT,
    "recibidaAt" TIMESTAMP(3),
    "pagadaAt" TIMESTAMP(3),
    "formaPago" "RestFormaPago",
    "bankAccountId" TEXT,
    "bankTransactionId" TEXT,

    CONSTRAINT "RestCompra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestCompraItem" (
    "id" TEXT NOT NULL,
    "compraId" TEXT NOT NULL,
    "insumoId" TEXT NOT NULL,
    "cantidad" DOUBLE PRECISION NOT NULL,
    "costoUnitario" DOUBLE PRECISION NOT NULL,
    "importe" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "RestCompraItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestMenuCategoria" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nombre" TEXT NOT NULL,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "activa" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RestMenuCategoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestMenuItem" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "categoriaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "precio" DOUBLE PRECISION NOT NULL,
    "claveProdServ" TEXT NOT NULL DEFAULT '90101500',
    "claveUnidad" TEXT NOT NULL DEFAULT 'E48',
    "estacion" "RestEstacion" NOT NULL DEFAULT 'COCINA',
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "disponible" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "RestMenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestReceta" (
    "id" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "insumoId" TEXT NOT NULL,
    "cantidad" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "RestReceta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestOrden" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "folio" INTEGER NOT NULL,
    "tipo" "RestOrdenTipo" NOT NULL DEFAULT 'MESA',
    "mesa" TEXT,
    "comensales" INTEGER,
    "clienteNombre" TEXT,
    "notas" TEXT,
    "meseroUserId" TEXT,
    "estado" "RestOrdenEstado" NOT NULL DEFAULT 'ABIERTA',
    "subtotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "iva" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "total" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "propina" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costoTotal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "formaPago" "RestOrdenFormaPago",
    "cobradaAt" TIMESTAMP(3),
    "bankAccountId" TEXT,
    "bankTransactionId" TEXT,
    "customerId" TEXT,
    "invoiceId" TEXT,

    CONSTRAINT "RestOrden_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestOrdenItem" (
    "id" TEXT NOT NULL,
    "ordenId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cantidad" DOUBLE PRECISION NOT NULL,
    "precioUnitario" DOUBLE PRECISION NOT NULL,
    "notas" TEXT,
    "estacion" "RestEstacion" NOT NULL DEFAULT 'COCINA',
    "estadoCocina" "RestItemEstado" NOT NULL DEFAULT 'PENDIENTE',
    "listoAt" TIMESTAMP(3),
    "costoUnitario" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "RestOrdenItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RestauranteConfig_companyId_key" ON "RestauranteConfig"("companyId");

-- CreateIndex
CREATE INDEX "RestInsumo_companyId_activo_idx" ON "RestInsumo"("companyId", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "RestInsumo_companyId_nombre_key" ON "RestInsumo"("companyId", "nombre");

-- CreateIndex
CREATE UNIQUE INDEX "RestCompra_bankTransactionId_key" ON "RestCompra"("bankTransactionId");

-- CreateIndex
CREATE INDEX "RestCompra_companyId_estado_idx" ON "RestCompra"("companyId", "estado");

-- CreateIndex
CREATE INDEX "RestCompra_companyId_fecha_idx" ON "RestCompra"("companyId", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "RestCompra_companyId_folio_key" ON "RestCompra"("companyId", "folio");

-- CreateIndex
CREATE INDEX "RestCompraItem_compraId_idx" ON "RestCompraItem"("compraId");

-- CreateIndex
CREATE INDEX "RestCompraItem_insumoId_idx" ON "RestCompraItem"("insumoId");

-- CreateIndex
CREATE INDEX "RestMenuCategoria_companyId_activa_idx" ON "RestMenuCategoria"("companyId", "activa");

-- CreateIndex
CREATE UNIQUE INDEX "RestMenuCategoria_companyId_nombre_key" ON "RestMenuCategoria"("companyId", "nombre");

-- CreateIndex
CREATE INDEX "RestMenuItem_companyId_activo_idx" ON "RestMenuItem"("companyId", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "RestMenuItem_companyId_nombre_key" ON "RestMenuItem"("companyId", "nombre");

-- CreateIndex
CREATE UNIQUE INDEX "RestReceta_menuItemId_insumoId_key" ON "RestReceta"("menuItemId", "insumoId");

-- CreateIndex
CREATE UNIQUE INDEX "RestOrden_bankTransactionId_key" ON "RestOrden"("bankTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "RestOrden_invoiceId_key" ON "RestOrden"("invoiceId");

-- CreateIndex
CREATE INDEX "RestOrden_companyId_estado_idx" ON "RestOrden"("companyId", "estado");

-- CreateIndex
CREATE INDEX "RestOrden_companyId_createdAt_idx" ON "RestOrden"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "RestOrden_companyId_folio_key" ON "RestOrden"("companyId", "folio");

-- CreateIndex
CREATE INDEX "RestOrdenItem_ordenId_idx" ON "RestOrdenItem"("ordenId");

-- CreateIndex
CREATE INDEX "RestOrdenItem_menuItemId_idx" ON "RestOrdenItem"("menuItemId");

-- CreateIndex
CREATE INDEX "RestOrdenItem_estadoCocina_idx" ON "RestOrdenItem"("estadoCocina");

-- AddForeignKey
ALTER TABLE "RestauranteConfig" ADD CONSTRAINT "RestauranteConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestInsumo" ADD CONSTRAINT "RestInsumo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestCompra" ADD CONSTRAINT "RestCompra_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestCompra" ADD CONSTRAINT "RestCompra_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestCompra" ADD CONSTRAINT "RestCompra_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestCompraItem" ADD CONSTRAINT "RestCompraItem_compraId_fkey" FOREIGN KEY ("compraId") REFERENCES "RestCompra"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestCompraItem" ADD CONSTRAINT "RestCompraItem_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "RestInsumo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestMenuCategoria" ADD CONSTRAINT "RestMenuCategoria_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestMenuItem" ADD CONSTRAINT "RestMenuItem_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestMenuItem" ADD CONSTRAINT "RestMenuItem_categoriaId_fkey" FOREIGN KEY ("categoriaId") REFERENCES "RestMenuCategoria"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestReceta" ADD CONSTRAINT "RestReceta_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "RestMenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestReceta" ADD CONSTRAINT "RestReceta_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "RestInsumo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestOrden" ADD CONSTRAINT "RestOrden_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestOrden" ADD CONSTRAINT "RestOrden_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestOrden" ADD CONSTRAINT "RestOrden_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestOrden" ADD CONSTRAINT "RestOrden_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestOrdenItem" ADD CONSTRAINT "RestOrdenItem_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "RestOrden"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestOrdenItem" ADD CONSTRAINT "RestOrdenItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "RestMenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

