-- Grupo de la lista de precios del hospital en el tarifario, y el servicio
-- (código del catálogo) que se hace en cada cita de la agenda.
ALTER TABLE "HospServicio" ADD COLUMN "grupo" TEXT;

ALTER TABLE "HospCita" ADD COLUMN "servicioId" TEXT;
ALTER TABLE "HospCita" ADD CONSTRAINT "HospCita_servicioId_fkey" FOREIGN KEY ("servicioId") REFERENCES "HospServicio"("id") ON DELETE SET NULL ON UPDATE CASCADE;
