-- Apertura del paso escrita por el copiloto, cacheada por el hash de la
-- evidencia: se regenera sólo cuando los datos del paso cambian.
ALTER TABLE "PasoCierre" ADD COLUMN "resumenCopiloto" TEXT,
ADD COLUMN "resumenHash" TEXT;
