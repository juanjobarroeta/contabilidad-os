-- AlterEnum
ALTER TYPE "HospCotizacionEstado" ADD VALUE 'PERDIDA';

-- AlterTable
ALTER TABLE "HospCotizacion" ADD COLUMN     "cerradaAt" TIMESTAMP(3),
ADD COLUMN     "contactoEmail" TEXT,
ADD COLUMN     "contactoNombre" TEXT,
ADD COLUMN     "contactoTelefono" TEXT,
ADD COLUMN     "enviadaAt" TIMESTAMP(3),
ADD COLUMN     "motivoPerdida" TEXT,
ADD COLUMN     "origen" TEXT,
ADD COLUMN     "perdidaContra" TEXT,
ADD COLUMN     "proximoSeguimiento" TIMESTAMP(3),
ADD COLUMN     "responsableUserId" TEXT;

-- CreateTable
CREATE TABLE "HospCotizacionSeguimiento" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "cotizacionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "userNombre" TEXT,
    "tipo" TEXT NOT NULL,
    "resultado" TEXT,
    "nota" TEXT,

    CONSTRAINT "HospCotizacionSeguimiento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HospCotizacionSeguimiento_cotizacionId_createdAt_idx" ON "HospCotizacionSeguimiento"("cotizacionId", "createdAt");

-- CreateIndex
CREATE INDEX "HospCotizacionSeguimiento_companyId_createdAt_idx" ON "HospCotizacionSeguimiento"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "HospCotizacion_companyId_proximoSeguimiento_idx" ON "HospCotizacion"("companyId", "proximoSeguimiento");

-- AddForeignKey
ALTER TABLE "HospCotizacionSeguimiento" ADD CONSTRAINT "HospCotizacionSeguimiento_cotizacionId_fkey" FOREIGN KEY ("cotizacionId") REFERENCES "HospCotizacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

