-- Descuento interno por partida de cotización (la impresa enseña sólo el neto).
ALTER TABLE "HospCotizacionPartida" ADD COLUMN "descuentoPct" DECIMAL(9,4);
ALTER TABLE "HospCotizacionPartida" ADD COLUMN "precioOriginal" DECIMAL(18,6);
