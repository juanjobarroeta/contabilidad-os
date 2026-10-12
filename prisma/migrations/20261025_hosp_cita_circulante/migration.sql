-- Agenda: el médico puede pedir enfermera circulante (además de instrumentista).
ALTER TABLE "HospCita" ADD COLUMN "solicitaCirculante" BOOLEAN NOT NULL DEFAULT false;
