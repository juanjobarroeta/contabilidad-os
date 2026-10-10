-- Correcciones a mano del índice del expediente clínico (renglón → SI/NO/NA).
ALTER TABLE "HospEpisodio" ADD COLUMN "indiceAjustes" JSONB;
