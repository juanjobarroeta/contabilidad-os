-- Float → Decimal, Ola 3: nómina (docs/FLOAT-DECIMAL.md).
-- float8 → numeric(18,6) VÍA TEXTO — el cast directo float8::numeric trunca
-- a 15 dígitos significativos (lección de la Ola 1); float8::text imprime la
-- representación más corta que round-tripea. NaN/Infinity revientan el
-- parse: dinero no-finito frena la migración. Un ALTER por tabla.
-- Incidencia.dias/horas entran aunque sean cantidades: multiplican contra
-- salarioDiario en calc-nomina y la aritmética debe vivir en un solo dominio.

ALTER TABLE "Employee"
  ALTER COLUMN "salarioDiario" TYPE numeric(18,6) USING round(("salarioDiario"::text)::numeric, 6),
  ALTER COLUMN "salarioDiarioIntegrado" TYPE numeric(18,6) USING round(("salarioDiarioIntegrado"::text)::numeric, 6),
  ALTER COLUMN "descuentoInfonavit" TYPE numeric(18,6) USING round(("descuentoInfonavit"::text)::numeric, 6),
  ALTER COLUMN "descuentoFonacot" TYPE numeric(18,6) USING round(("descuentoFonacot"::text)::numeric, 6),
  ALTER COLUMN "pensionAlimenticiaValor" TYPE numeric(18,6) USING round(("pensionAlimenticiaValor"::text)::numeric, 6);

ALTER TABLE "Incidencia"
  ALTER COLUMN "dias" TYPE numeric(18,6) USING round(("dias"::text)::numeric, 6),
  ALTER COLUMN "horas" TYPE numeric(18,6) USING round(("horas"::text)::numeric, 6),
  ALTER COLUMN "horasTriples" TYPE numeric(18,6) USING round(("horasTriples"::text)::numeric, 6),
  ALTER COLUMN "monto" TYPE numeric(18,6) USING round(("monto"::text)::numeric, 6);

ALTER TABLE "ImssMovimiento"
  ALTER COLUMN "sbcAnterior" TYPE numeric(18,6) USING round(("sbcAnterior"::text)::numeric, 6),
  ALTER COLUMN "sbcNuevo" TYPE numeric(18,6) USING round(("sbcNuevo"::text)::numeric, 6);

ALTER TABLE "PayrollRun"
  ALTER COLUMN "totalPercepciones" TYPE numeric(18,6) USING round(("totalPercepciones"::text)::numeric, 6),
  ALTER COLUMN "totalDeducciones" TYPE numeric(18,6) USING round(("totalDeducciones"::text)::numeric, 6),
  ALTER COLUMN "totalNeto" TYPE numeric(18,6) USING round(("totalNeto"::text)::numeric, 6);

ALTER TABLE "PayrollItem"
  ALTER COLUMN "sueldoBase" TYPE numeric(18,6) USING round(("sueldoBase"::text)::numeric, 6),
  ALTER COLUMN "horasExtra" TYPE numeric(18,6) USING round(("horasExtra"::text)::numeric, 6),
  ALTER COLUMN "bonosPagoFijo" TYPE numeric(18,6) USING round(("bonosPagoFijo"::text)::numeric, 6),
  ALTER COLUMN "bonosPagoVar" TYPE numeric(18,6) USING round(("bonosPagoVar"::text)::numeric, 6),
  ALTER COLUMN "vales" TYPE numeric(18,6) USING round(("vales"::text)::numeric, 6),
  ALTER COLUMN "otrasPercepciones" TYPE numeric(18,6) USING round(("otrasPercepciones"::text)::numeric, 6),
  ALTER COLUMN "isrRetenido" TYPE numeric(18,6) USING round(("isrRetenido"::text)::numeric, 6),
  ALTER COLUMN "imssObrero" TYPE numeric(18,6) USING round(("imssObrero"::text)::numeric, 6),
  ALTER COLUMN "imssPatronal" TYPE numeric(18,6) USING round(("imssPatronal"::text)::numeric, 6),
  ALTER COLUMN "infonavit" TYPE numeric(18,6) USING round(("infonavit"::text)::numeric, 6),
  ALTER COLUMN "otrasDeducc" TYPE numeric(18,6) USING round(("otrasDeducc"::text)::numeric, 6),
  ALTER COLUMN "aguinaldo" TYPE numeric(18,6) USING round(("aguinaldo"::text)::numeric, 6),
  ALTER COLUMN "primaVacacional" TYPE numeric(18,6) USING round(("primaVacacional"::text)::numeric, 6),
  ALTER COLUMN "vacaciones" TYPE numeric(18,6) USING round(("vacaciones"::text)::numeric, 6),
  ALTER COLUMN "ptu" TYPE numeric(18,6) USING round(("ptu"::text)::numeric, 6),
  ALTER COLUMN "totalPercepciones" TYPE numeric(18,6) USING round(("totalPercepciones"::text)::numeric, 6),
  ALTER COLUMN "totalDeducciones" TYPE numeric(18,6) USING round(("totalDeducciones"::text)::numeric, 6),
  ALTER COLUMN "netoAPagar" TYPE numeric(18,6) USING round(("netoAPagar"::text)::numeric, 6);

ALTER TABLE "NominaCosto"
  ALTER COLUMN "percepciones" TYPE numeric(18,6) USING round(("percepciones"::text)::numeric, 6),
  ALTER COLUMN "cuotasPatronales" TYPE numeric(18,6) USING round(("cuotasPatronales"::text)::numeric, 6),
  ALTER COLUMN "sbcDiario" TYPE numeric(18,6) USING round(("sbcDiario"::text)::numeric, 6);
