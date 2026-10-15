-- Farmacia surte lo cotizado: la partida guarda el cargo con que pasó a la cuenta.
ALTER TABLE "HospCotizacionPartida" ADD COLUMN "cargoId" TEXT;
ALTER TABLE "HospCotizacionPartida" ADD COLUMN "surtidaAt" TIMESTAMP(3);
ALTER TABLE "HospCotizacionPartida" ADD COLUMN "surtidaPor" TEXT;
CREATE UNIQUE INDEX "HospCotizacionPartida_cargoId_key" ON "HospCotizacionPartida"("cargoId");
