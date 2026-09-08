-- ISN (Impuesto Sobre Nóminas) como obligación declarable, POR ESTADO.
--
-- El motor de ISN existía desde hace tiempo —tasa por entidad, con su ley y su
-- artículo— pero sólo alimentaba hallazgos del auditor: no había tipo de
-- declaración, ni fecha límite, ni renglón en el total del mes. Un impuesto que
-- la app calculaba y luego olvidaba.
--
-- Se declara y se paga POR ESTADO ante una tesorería distinta, así que hay una
-- fila por (periodo, entidad): sin eso no se puede marcar presentado uno y
-- pendiente el otro. `isnDetalle` guarda la base, la tasa y el fundamento con
-- que se calculó esa entidad, congelados al presentar.
ALTER TYPE "TaxDeclarationType" ADD VALUE IF NOT EXISTS 'ISN_MENSUAL';
ALTER TABLE "TaxDeclaration" ADD COLUMN "isnEntidad" TEXT;
ALTER TABLE "TaxDeclaration" ADD COLUMN "isnPagar" DECIMAL(18,6);
ALTER TABLE "TaxDeclaration" ADD COLUMN "isnDetalle" JSONB;
CREATE INDEX "TaxDeclaration_companyId_tipo_periodo_isnEntidad_idx"
  ON "TaxDeclaration" ("companyId", "tipo", "periodo", "isnEntidad");
