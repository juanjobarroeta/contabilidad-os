-- Cotizaciones para médicos y en paquete (total con IVA pactado, partidas sin precio en la carta).
-- AlterTable
ALTER TABLE "HospCotizacion" ADD COLUMN     "dirigidaA" TEXT,
ADD COLUMN     "medicoId" TEXT,
ADD COLUMN     "precioPaquete" DECIMAL(18,6);

-- CreateIndex
CREATE INDEX "HospCotizacion_companyId_medicoId_idx" ON "HospCotizacion"("companyId", "medicoId");

-- AddForeignKey
ALTER TABLE "HospCotizacion" ADD CONSTRAINT "HospCotizacion_medicoId_fkey" FOREIGN KEY ("medicoId") REFERENCES "HospMedico"("id") ON DELETE SET NULL ON UPDATE CASCADE;

