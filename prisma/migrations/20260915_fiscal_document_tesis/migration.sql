-- Jurisprudencia de la SCJN en el corpus (docs/MOTOR-JURIDICO.md F1).
CREATE TYPE "TipoCriterio" AS ENUM ('JURISPRUDENCIA', 'AISLADA');
CREATE TYPE "EstadoCriterio" AS ENUM ('VIGENTE', 'INTERRUMPIDA', 'SUSTITUIDA', 'SUPERADA');

ALTER TABLE "FiscalDocument"
  ADD COLUMN "registro" TEXT,
  ADD COLUMN "numeroTesis" TEXT,
  ADD COLUMN "epoca" TEXT,
  ADD COLUMN "instancia" TEXT,
  ADD COLUMN "organo" TEXT,
  ADD COLUMN "tipoCriterio" "TipoCriterio",
  ADD COLUMN "estadoCriterio" "EstadoCriterio",
  ADD COLUMN "fechaPublicacion" TIMESTAMP(3);

CREATE UNIQUE INDEX "FiscalDocument_registro_key" ON "FiscalDocument"("registro");
CREATE INDEX "FiscalDocument_epoca_tipoCriterio_idx" ON "FiscalDocument"("epoca", "tipoCriterio");

CREATE TABLE "SjfTesisVista" (
  "registro" TEXT NOT NULL,
  "epoca" TEXT,
  "huella" TEXT NOT NULL,
  "ingerida" BOOLEAN NOT NULL DEFAULT false,
  "vistaAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SjfTesisVista_pkey" PRIMARY KEY ("registro")
);
CREATE INDEX "SjfTesisVista_epoca_ingerida_idx" ON "SjfTesisVista"("epoca", "ingerida");
