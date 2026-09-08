-- ISN (Impuesto Sobre Nóminas) como obligación declarable.
--
-- El motor de ISN existía desde hace tiempo —tasa por entidad, con su ley y su
-- artículo— pero sólo alimentaba hallazgos del auditor: no había tipo de
-- declaración, ni fecha límite, ni renglón en el total del mes. Un impuesto que
-- la app calcula y luego olvida.
--
-- `isnDetalle` guarda el desglose por entidad (una empresa con sucursales lo debe
-- a varios estados a la vez); `isnPagar` sólo suma las entidades cuya tasa está
-- en el catálogo.
ALTER TYPE "TaxDeclarationType" ADD VALUE IF NOT EXISTS 'ISN_MENSUAL';
ALTER TABLE "TaxDeclaration" ADD COLUMN "isnPagar" DECIMAL(18,6);
ALTER TABLE "TaxDeclaration" ADD COLUMN "isnDetalle" JSONB;
