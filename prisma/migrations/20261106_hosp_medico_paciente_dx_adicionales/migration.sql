-- Médico tratante por default del paciente y diagnósticos de ingreso adicionales. Aditiva.
ALTER TABLE "HospPaciente" ADD COLUMN "medicoId" TEXT;
ALTER TABLE "HospPaciente" ADD CONSTRAINT "HospPaciente_medicoId_fkey" FOREIGN KEY ("medicoId") REFERENCES "HospMedico"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "HospEpisodio" ADD COLUMN "diagnosticosAdicionales" JSONB;
