-- Rastro de la consulta de balanzas presentadas: distingue «el SAT no tiene CE
-- de esta empresa» de «todavía no lo hemos consultado».
ALTER TABLE "Company" ADD COLUMN "cePresentadaRevisadaEn" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "cePresentadaRegistros" INTEGER;
