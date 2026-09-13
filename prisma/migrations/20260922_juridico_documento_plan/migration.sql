-- Borradores por esquema: plan, estado, revisión y versiones.
ALTER TABLE "JuridicoDocumento" ADD COLUMN "plan" JSONB;
ALTER TABLE "JuridicoDocumento" ADD COLUMN "estado" TEXT NOT NULL DEFAULT 'final';
ALTER TABLE "JuridicoDocumento" ADD COLUMN "revision" JSONB;
ALTER TABLE "JuridicoDocumento" ADD COLUMN "versiones" JSONB;
