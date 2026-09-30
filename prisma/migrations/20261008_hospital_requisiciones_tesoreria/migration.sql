-- HospitalOS: requisiciones → orden → recepción → CFDI → autorización de pago
-- → tesorería, sobre el motor de compras de obra (SolicitudCompra,
-- SolicitudAdjudicacion, PagoProveedor). Aditiva.
ALTER TABLE "SolicitudCompra" ADD COLUMN IF NOT EXISTS "origen" TEXT;
ALTER TABLE "SolicitudCompra" ADD COLUMN IF NOT EXISTS "area" TEXT;
ALTER TABLE "SolicitudCompra" ADD COLUMN IF NOT EXISTS "rechazadaPorId" TEXT;
ALTER TABLE "SolicitudCompra" ADD COLUMN IF NOT EXISTS "rechazadaAt" TIMESTAMP(3);
ALTER TABLE "SolicitudCompra" ADD COLUMN IF NOT EXISTS "rechazoMotivo" TEXT;

ALTER TABLE "SolicitudPartida" ADD COLUMN IF NOT EXISTS "hospInsumoId" TEXT;
ALTER TABLE "SolicitudPartida" ADD COLUMN IF NOT EXISTS "cantidadRecibida" DECIMAL(18,6) NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE "SolicitudPartida" ADD CONSTRAINT "SolicitudPartida_hospInsumoId_fkey" FOREIGN KEY ("hospInsumoId") REFERENCES "HospInsumo"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "construccion_solicitud_adjudicacion" ADD COLUMN IF NOT EXISTS "pagoAutorizadoPorId" TEXT;
ALTER TABLE "construccion_solicitud_adjudicacion" ADD COLUMN IF NOT EXISTS "fechaProgramada" TIMESTAMP(3);

ALTER TABLE "HospMovimientoInsumo" ADD COLUMN IF NOT EXISTS "solicitudPartidaId" TEXT;
CREATE INDEX IF NOT EXISTS "HospMovimientoInsumo_solicitudPartidaId_idx" ON "HospMovimientoInsumo"("solicitudPartidaId");
DO $$ BEGIN
  ALTER TABLE "HospMovimientoInsumo" ADD CONSTRAINT "HospMovimientoInsumo_solicitudPartidaId_fkey" FOREIGN KEY ("solicitudPartidaId") REFERENCES "SolicitudPartida"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
