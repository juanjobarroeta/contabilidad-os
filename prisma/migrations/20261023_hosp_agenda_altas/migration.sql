-- Agenda: días de estancia previstos y médicos dados de alta desde la agenda
-- (sólo el nombre) pendientes de credencializar.
ALTER TABLE "HospCita" ADD COLUMN "diasEstancia" INTEGER;
ALTER TABLE "HospMedico" ADD COLUMN "porCredencializar" BOOLEAN NOT NULL DEFAULT false;
