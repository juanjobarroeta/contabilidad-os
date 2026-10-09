-- Solicitudes por programar (la hoja 2 del Excel de quirófano) y minutos de
-- limpieza entre casos por recurso.
ALTER TYPE "HospCitaEstado" ADD VALUE 'SOLICITADA' BEFORE 'PROGRAMADA';

ALTER TABLE "HospCita" ADD COLUMN "horaPorDefinir" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "HospRecurso" ADD COLUMN "minutosLimpieza" INTEGER NOT NULL DEFAULT 0;
