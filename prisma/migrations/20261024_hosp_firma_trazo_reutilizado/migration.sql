-- Firma del paquete de admisión: el trazo se captura una vez y se aplica a
-- cada documento con un «Acepto» después de leerlo; la firma lo declara.
ALTER TABLE "HospFirma" ADD COLUMN "trazoReutilizado" BOOLEAN NOT NULL DEFAULT false;
