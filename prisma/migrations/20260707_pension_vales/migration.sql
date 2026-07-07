-- Conceptos recurrentes de nómina por empleado. Columnas ADITIVAS (nullable,
-- sin defaults ni backfill): los empleados existentes quedan sin pensión ni
-- vales hasta que se capturen en su ficha.
--   - Pensión alimenticia (resolución judicial): deducción post-impuestos por
--     periodo; en el CFDI viaja con c_TipoDeduccion 007.
--   - Vales de despensa: monto MENSUAL recurrente, prorrateado por días
--     efectivos; en el CFDI viaja con c_TipoPercepcion 029.
ALTER TABLE "Employee" ADD COLUMN "pensionAlimenticiaTipo" TEXT;
ALTER TABLE "Employee" ADD COLUMN "pensionAlimenticiaValor" DOUBLE PRECISION;
ALTER TABLE "Employee" ADD COLUMN "valesDespensaMensual" DOUBLE PRECISION;
