-- CreateEnum
CREATE TYPE "PurifCorteEstado" AS ENUM ('BORRADOR', 'CONFIRMADO');

-- AlterTable
ALTER TABLE "PurifConfig" ADD COLUMN     "claveProdServ" TEXT NOT NULL DEFAULT '50202306',
ADD COLUMN     "claveUnidad" TEXT NOT NULL DEFAULT 'H87',
ADD COLUMN     "descripcionFactura" TEXT NOT NULL DEFAULT 'Agua purificada en garrafón 20 L';

-- AlterTable
ALTER TABLE "PurifVenta" ADD COLUMN     "corteId" TEXT;

-- AlterTable
ALTER TABLE "PurifVentaItem" ADD COLUMN     "sucursalId" TEXT;

-- CreateTable
CREATE TABLE "PurifClienteConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "precioGarrafon" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "PurifClienteConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurifRuta" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PurifRuta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurifSucursal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nombre" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PurifSucursal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurifCorte" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "estado" "PurifCorteEstado" NOT NULL DEFAULT 'BORRADOR',
    "cortesiasGarrafones" INTEGER NOT NULL DEFAULT 0,
    "cortesiasImporte" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notas" TEXT,
    "confirmadoAt" TIMESTAMP(3),

    CONSTRAINT "PurifCorte_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurifCorteRuta" (
    "id" TEXT NOT NULL,
    "corteId" TEXT NOT NULL,
    "rutaId" TEXT NOT NULL,
    "efectivo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "transferencia" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "garrafones" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PurifCorteRuta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurifCorteEmpresa" (
    "id" TEXT NOT NULL,
    "corteId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "sucursalId" TEXT,
    "garrafones" INTEGER NOT NULL,

    CONSTRAINT "PurifCorteEmpresa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurifCorteGasto" (
    "id" TEXT NOT NULL,
    "corteId" TEXT NOT NULL,
    "categoria" "PurifGastoCategoria" NOT NULL,
    "descripcion" TEXT NOT NULL,
    "monto" DOUBLE PRECISION NOT NULL,
    "formaPago" "PurifFormaPago" NOT NULL DEFAULT 'EFECTIVO',

    CONSTRAINT "PurifCorteGasto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurifClienteConfig_companyId_customerId_key" ON "PurifClienteConfig"("companyId", "customerId");

-- CreateIndex
CREATE UNIQUE INDEX "PurifRuta_companyId_nombre_key" ON "PurifRuta"("companyId", "nombre");

-- CreateIndex
CREATE INDEX "PurifSucursal_companyId_idx" ON "PurifSucursal"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "PurifSucursal_customerId_nombre_key" ON "PurifSucursal"("customerId", "nombre");

-- CreateIndex
CREATE INDEX "PurifCorte_companyId_estado_idx" ON "PurifCorte"("companyId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "PurifCorte_companyId_fecha_key" ON "PurifCorte"("companyId", "fecha");

-- CreateIndex
CREATE UNIQUE INDEX "PurifCorteRuta_corteId_rutaId_key" ON "PurifCorteRuta"("corteId", "rutaId");

-- CreateIndex
CREATE INDEX "PurifCorteEmpresa_corteId_idx" ON "PurifCorteEmpresa"("corteId");

-- CreateIndex
CREATE INDEX "PurifCorteGasto_corteId_idx" ON "PurifCorteGasto"("corteId");

-- CreateIndex
CREATE INDEX "PurifVenta_corteId_idx" ON "PurifVenta"("corteId");

-- CreateIndex
CREATE INDEX "PurifVentaItem_sucursalId_idx" ON "PurifVentaItem"("sucursalId");

-- AddForeignKey
ALTER TABLE "PurifClienteConfig" ADD CONSTRAINT "PurifClienteConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifClienteConfig" ADD CONSTRAINT "PurifClienteConfig_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifRuta" ADD CONSTRAINT "PurifRuta_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifSucursal" ADD CONSTRAINT "PurifSucursal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifSucursal" ADD CONSTRAINT "PurifSucursal_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifCorte" ADD CONSTRAINT "PurifCorte_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifCorteRuta" ADD CONSTRAINT "PurifCorteRuta_corteId_fkey" FOREIGN KEY ("corteId") REFERENCES "PurifCorte"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifCorteRuta" ADD CONSTRAINT "PurifCorteRuta_rutaId_fkey" FOREIGN KEY ("rutaId") REFERENCES "PurifRuta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifCorteEmpresa" ADD CONSTRAINT "PurifCorteEmpresa_corteId_fkey" FOREIGN KEY ("corteId") REFERENCES "PurifCorte"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifCorteEmpresa" ADD CONSTRAINT "PurifCorteEmpresa_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifCorteEmpresa" ADD CONSTRAINT "PurifCorteEmpresa_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "PurifSucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifCorteGasto" ADD CONSTRAINT "PurifCorteGasto_corteId_fkey" FOREIGN KEY ("corteId") REFERENCES "PurifCorte"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifVenta" ADD CONSTRAINT "PurifVenta_corteId_fkey" FOREIGN KEY ("corteId") REFERENCES "PurifCorte"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifVentaItem" ADD CONSTRAINT "PurifVentaItem_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "PurifSucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

