-- Un solo corpus jurídico, dos alcances (docs/MOTOR-JURIDICO.md §3.1): cada
-- ordenamiento lleva sus materias y su ámbito; el hub filtra por las materias
-- del contador, el producto legal no filtra.
CREATE TYPE "AmbitoJuridico" AS ENUM ('FEDERAL', 'ESTATAL', 'MUNICIPAL', 'INTERNACIONAL');

ALTER TABLE "FiscalDocument"
  ADD COLUMN "materias" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "ambito" "AmbitoJuridico" NOT NULL DEFAULT 'FEDERAL',
  ADD COLUMN "entidad" TEXT;

-- Lo ya cargado era todo del contador. Las etiquetas finas las trae el
-- catálogo en el siguiente refresco (la ingesta sincroniza materias aunque el
-- texto no cambie); aquí sólo lo que hace falta para que el filtro del hub
-- no esconda nada el día del despliegue.
UPDATE "FiscalDocument" SET "materias" = ARRAY['fiscal'] WHERE cardinality("materias") = 0;
UPDATE "FiscalDocument" SET "materias" = ARRAY['fiscal', 'procesal'] WHERE "clave" IN ('CFF', 'RCFF');
UPDATE "FiscalDocument" SET "materias" = ARRAY['laboral'] WHERE "clave" = 'LFT';
UPDATE "FiscalDocument" SET "materias" = ARRAY['seguridad_social', 'laboral'] WHERE "clave" IN ('LSS', 'RACERF');
UPDATE "FiscalDocument" SET "materias" = ARRAY['seguridad_social', 'laboral', 'vivienda'] WHERE "clave" IN ('LINFONAVIT', 'RIPAEDI');
UPDATE "FiscalDocument" SET "materias" = ARRAY['mercantil', 'procesal'] WHERE "clave" = 'CCOM';
UPDATE "FiscalDocument" SET "materias" = ARRAY['mercantil'] WHERE "clave" = 'LGSM';
UPDATE "FiscalDocument" SET "materias" = ARRAY['pld', 'mercantil'] WHERE "clave" IN ('LFPIORPI', 'RLFPIORPI');
UPDATE "FiscalDocument" SET "ambito" = 'ESTATAL', "entidad" = 'PUE' WHERE "clave" IN ('LHPUE', 'CFPUE');
UPDATE "FiscalDocument" SET "ambito" = 'ESTATAL', "entidad" = 'CMX' WHERE "clave" = 'CFCDMX';

CREATE INDEX "FiscalDocument_materias_idx" ON "FiscalDocument" USING GIN ("materias");
