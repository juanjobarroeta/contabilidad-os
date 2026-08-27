-- Float → Decimal, Ola 4: mayor y declaraciones (docs/FLOAT-DECIMAL.md).
-- float8 → numeric(18,6) VÍA TEXTO — el cast directo trunca a 15 dígitos
-- significativos (lección de la Ola 1). NaN/Infinity revientan el parse:
-- dinero no-finito frena la migración. Un ALTER por tabla.
-- AccountingEntry es la tabla grande de esta ola (una fila por línea de
-- póliza); mismo protocolo: falla → deploy abortado, imagen anterior sigue.

ALTER TABLE "ActivoFijo"
  ALTER COLUMN "moi" TYPE numeric(18,6) USING round(("moi"::text)::numeric, 6),
  ALTER COLUMN "tasaAnual" TYPE numeric(18,6) USING round(("tasaAnual"::text)::numeric, 6);

ALTER TABLE "TaxDeclaration"
  ALTER COLUMN "ivaTrasladadoCobrado" TYPE numeric(18,6) USING round(("ivaTrasladadoCobrado"::text)::numeric, 6),
  ALTER COLUMN "ivaAcreditableGastado" TYPE numeric(18,6) USING round(("ivaAcreditableGastado"::text)::numeric, 6),
  ALTER COLUMN "ivaSaldoFavor" TYPE numeric(18,6) USING round(("ivaSaldoFavor"::text)::numeric, 6),
  ALTER COLUMN "ivaPagar" TYPE numeric(18,6) USING round(("ivaPagar"::text)::numeric, 6),
  ALTER COLUMN "ivaSaldoFavorAnterior" TYPE numeric(18,6) USING round(("ivaSaldoFavorAnterior"::text)::numeric, 6),
  ALTER COLUMN "iepsPagar" TYPE numeric(18,6) USING round(("iepsPagar"::text)::numeric, 6),
  ALTER COLUMN "iepsSaldoFavor" TYPE numeric(18,6) USING round(("iepsSaldoFavor"::text)::numeric, 6),
  ALTER COLUMN "isrIngresos" TYPE numeric(18,6) USING round(("isrIngresos"::text)::numeric, 6),
  ALTER COLUMN "isrDeducciones" TYPE numeric(18,6) USING round(("isrDeducciones"::text)::numeric, 6),
  ALTER COLUMN "isrBaseGravable" TYPE numeric(18,6) USING round(("isrBaseGravable"::text)::numeric, 6),
  ALTER COLUMN "isrTasa" TYPE numeric(18,6) USING round(("isrTasa"::text)::numeric, 6),
  ALTER COLUMN "isrPagar" TYPE numeric(18,6) USING round(("isrPagar"::text)::numeric, 6),
  ALTER COLUMN "isrCoeficienteUtilidad" TYPE numeric(18,6) USING round(("isrCoeficienteUtilidad"::text)::numeric, 6),
  ALTER COLUMN "isrPerdidaPendiente" TYPE numeric(18,6) USING round(("isrPerdidaPendiente"::text)::numeric, 6),
  ALTER COLUMN "isrSaldoFavor" TYPE numeric(18,6) USING round(("isrSaldoFavor"::text)::numeric, 6),
  ALTER COLUMN "retencionesIsr" TYPE numeric(18,6) USING round(("retencionesIsr"::text)::numeric, 6),
  ALTER COLUMN "imssCuotas" TYPE numeric(18,6) USING round(("imssCuotas"::text)::numeric, 6);

ALTER TABLE "PerdidaFiscal"
  ALTER COLUMN "montoOriginal" TYPE numeric(18,6) USING round(("montoOriginal"::text)::numeric, 6),
  ALTER COLUMN "saldoActualizado" TYPE numeric(18,6) USING round(("saldoActualizado"::text)::numeric, 6);

ALTER TABLE "AccountingEntry"
  ALTER COLUMN "monto" TYPE numeric(18,6) USING round(("monto"::text)::numeric, 6);

ALTER TABLE "AccountingPeriod"
  ALTER COLUMN "totalCargos" TYPE numeric(18,6) USING round(("totalCargos"::text)::numeric, 6),
  ALTER COLUMN "totalAbonos" TYPE numeric(18,6) USING round(("totalAbonos"::text)::numeric, 6);

ALTER TABLE "CeBalanzaMes"
  ALTER COLUMN "saldoIni" TYPE numeric(18,6) USING round(("saldoIni"::text)::numeric, 6),
  ALTER COLUMN "debe" TYPE numeric(18,6) USING round(("debe"::text)::numeric, 6),
  ALTER COLUMN "haber" TYPE numeric(18,6) USING round(("haber"::text)::numeric, 6),
  ALTER COLUMN "saldoFin" TYPE numeric(18,6) USING round(("saldoFin"::text)::numeric, 6);
