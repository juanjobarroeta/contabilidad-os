-- IEPS fase 1: tipo de declaración + montos capturados del acuse.
-- El motor de cálculo llega después; esto hace RASTREABLE la obligación
-- (checklist, vencimientos, acuses) para contribuyentes con IEPS.
ALTER TYPE "TaxDeclarationType" ADD VALUE 'IEPS_MENSUAL';

ALTER TABLE "TaxDeclaration"
  ADD COLUMN "iepsPagar" DOUBLE PRECISION,
  ADD COLUMN "iepsSaldoFavor" DOUBLE PRECISION;
