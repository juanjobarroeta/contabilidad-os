-- CreateEnum
CREATE TYPE "HospUrgencia" AS ENUM ('URGENTE', 'SEMIURGENTE', 'NORMAL');

-- CreateEnum
CREATE TYPE "HospLineaAreaCierre" AS ENUM ('DESABASTO', 'CANCELADA');

-- AlterTable
ALTER TABLE "SolicitudCompra" ADD COLUMN     "pedidoEnviadoAt" TIMESTAMP(3),
ADD COLUMN     "pedidoEnviadoPorId" TEXT,
ADD COLUMN     "pedidoEnviadoVia" TEXT;

-- CreateTable
CREATE TABLE "HospSolicitudArea" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "folio" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "urgencia" "HospUrgencia" NOT NULL DEFAULT 'NORMAL',
    "notas" TEXT,
    "solicitanteId" TEXT,
    "solicitanteNombre" TEXT,

    CONSTRAINT "HospSolicitudArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospSolicitudAreaLinea" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "solicitudId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "hospInsumoId" TEXT,
    "descripcion" TEXT NOT NULL,
    "unidad" TEXT,
    "cantidad" DECIMAL(18,6) NOT NULL,
    "urgencia" "HospUrgencia" NOT NULL DEFAULT 'NORMAL',
    "motivo" TEXT,
    "requisicionId" TEXT,
    "solicitudPartidaId" TEXT,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "proveedoresIntentados" TEXT[],
    "cantidadSurtidaPrevia" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "cierre" "HospLineaAreaCierre",
    "cierreMotivo" TEXT,
    "cerradaAt" TIMESTAMP(3),
    "cerradaPorId" TEXT,

    CONSTRAINT "HospSolicitudAreaLinea_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HospSolicitudArea_companyId_createdAt_idx" ON "HospSolicitudArea"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "HospSolicitudArea_companyId_folio_key" ON "HospSolicitudArea"("companyId", "folio");

-- CreateIndex
CREATE UNIQUE INDEX "HospSolicitudAreaLinea_solicitudPartidaId_key" ON "HospSolicitudAreaLinea"("solicitudPartidaId");

-- CreateIndex
CREATE INDEX "HospSolicitudAreaLinea_companyId_requisicionId_idx" ON "HospSolicitudAreaLinea"("companyId", "requisicionId");

-- CreateIndex
CREATE INDEX "HospSolicitudAreaLinea_solicitudId_idx" ON "HospSolicitudAreaLinea"("solicitudId");

-- AddForeignKey
ALTER TABLE "HospSolicitudArea" ADD CONSTRAINT "HospSolicitudArea_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospSolicitudAreaLinea" ADD CONSTRAINT "HospSolicitudAreaLinea_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospSolicitudAreaLinea" ADD CONSTRAINT "HospSolicitudAreaLinea_solicitudId_fkey" FOREIGN KEY ("solicitudId") REFERENCES "HospSolicitudArea"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospSolicitudAreaLinea" ADD CONSTRAINT "HospSolicitudAreaLinea_hospInsumoId_fkey" FOREIGN KEY ("hospInsumoId") REFERENCES "HospInsumo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospSolicitudAreaLinea" ADD CONSTRAINT "HospSolicitudAreaLinea_requisicionId_fkey" FOREIGN KEY ("requisicionId") REFERENCES "SolicitudCompra"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospSolicitudAreaLinea" ADD CONSTRAINT "HospSolicitudAreaLinea_solicitudPartidaId_fkey" FOREIGN KEY ("solicitudPartidaId") REFERENCES "SolicitudPartida"("id") ON DELETE SET NULL ON UPDATE CASCADE;

