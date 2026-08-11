-- Marca de parse completado del acuse anual: mata el loop de re-parseo
-- infinito (243 llamadas a Claude/mes en una empresa) cuando el PDF nunca
-- rinde los campos del centinela.
ALTER TABLE "TaxDeclaration" ADD COLUMN "acuseParseadoAt" TIMESTAMP(3);
