-- Surtido de lo cotizado contra inventario: el servicio recuerda su insumo y
-- cada cargo de farmacia puede surtir una partida de la cotización.
ALTER TABLE "HospServicio" ADD COLUMN "insumoId" TEXT;
ALTER TABLE "HospServicio" ADD CONSTRAINT "HospServicio_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "HospInsumo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "HospCargo" ADD COLUMN "cotizacionPartidaId" TEXT;
CREATE INDEX "HospCargo_cotizacionPartidaId_idx" ON "HospCargo"("cotizacionPartidaId");
ALTER TABLE "HospCargo" ADD CONSTRAINT "HospCargo_cotizacionPartidaId_fkey" FOREIGN KEY ("cotizacionPartidaId") REFERENCES "HospCotizacionPartida"("id") ON DELETE SET NULL ON UPDATE CASCADE;
