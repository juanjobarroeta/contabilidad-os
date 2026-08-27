-- CreateEnum
CREATE TYPE "CitaServicioEstado" AS ENUM ('PENDIENTE', 'CONFIRMADA', 'CANCELADA', 'RECIBIDA', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "CitaServicioCanal" AS ENUM ('PORTAL', 'STAFF');

-- CreateEnum
CREATE TYPE "OrdenDocumentoTipo" AS ENUM ('FOTO_RECEPCION', 'CONTRATO_FIRMADO', 'OTRO');

-- AlterTable
ALTER TABLE "OrdenServicio" ADD COLUMN     "firmadoAt" TIMESTAMP(3),
ADD COLUMN     "garantiaDias" INTEGER,
ADD COLUMN     "gasolinaOctavos" INTEGER,
ADD COLUMN     "inventarioRecepcion" JSONB,
ADD COLUMN     "torre" TEXT;

-- CreateTable
CREATE TABLE "CitaServicio" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "estado" "CitaServicioEstado" NOT NULL DEFAULT 'PENDIENTE',
    "canal" "CitaServicioCanal" NOT NULL DEFAULT 'PORTAL',
    "customerId" TEXT,
    "clienteNombre" TEXT,
    "telefono" TEXT,
    "vehiculoId" TEXT,
    "vin" TEXT,
    "descripcionUnidad" TEXT,
    "placas" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL,
    "motivo" TEXT NOT NULL,
    "notas" TEXT,
    "confirmadaAt" TIMESTAMP(3),
    "canceladaAt" TIMESTAMP(3),
    "canceladaPor" TEXT,
    "recordatorioEnviadoAt" TIMESTAMP(3),
    "ordenId" TEXT,

    CONSTRAINT "CitaServicio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrdenDocumento" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ordenId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "tipo" "OrdenDocumentoTipo" NOT NULL,
    "nombre" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "datos" BYTEA NOT NULL,

    CONSTRAINT "OrdenDocumento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CitaServicio_ordenId_key" ON "CitaServicio"("ordenId");

-- CreateIndex
CREATE INDEX "CitaServicio_companyId_fecha_idx" ON "CitaServicio"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "CitaServicio_companyId_estado_idx" ON "CitaServicio"("companyId", "estado");

-- CreateIndex
CREATE INDEX "CitaServicio_customerId_idx" ON "CitaServicio"("customerId");

-- CreateIndex
CREATE INDEX "OrdenDocumento_ordenId_idx" ON "OrdenDocumento"("ordenId");

-- CreateIndex
CREATE INDEX "OrdenDocumento_companyId_idx" ON "OrdenDocumento"("companyId");

-- AddForeignKey
ALTER TABLE "CitaServicio" ADD CONSTRAINT "CitaServicio_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitaServicio" ADD CONSTRAINT "CitaServicio_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitaServicio" ADD CONSTRAINT "CitaServicio_vehiculoId_fkey" FOREIGN KEY ("vehiculoId") REFERENCES "Vehiculo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CitaServicio" ADD CONSTRAINT "CitaServicio_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "OrdenServicio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrdenDocumento" ADD CONSTRAINT "OrdenDocumento_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "OrdenServicio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

