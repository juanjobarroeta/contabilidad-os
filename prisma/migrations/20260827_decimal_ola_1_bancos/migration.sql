-- Float → Decimal, Ola 1: bancos (docs/FLOAT-DECIMAL.md).
-- float8 → numeric(18,6) casteando VÍA TEXTO: float8out imprime la
-- representación decimal más corta que round-tripea (la que la app siempre
-- vio), mientras que el cast directo float8::numeric trunca a 15 dígitos
-- significativos (ensayado: 1234567890.123456 → 1234567890.12346). Con 16+
-- dígitos el camino directo pierde la cola; el de texto no. NaN/Infinity
-- reventarían el parse de numeric — correcto: dinero no-finito debe frenar
-- la migración, no colarse. Un solo ALTER por tabla = una sola reescritura.

ALTER TABLE "BankTransaction"
  ALTER COLUMN "monto" TYPE numeric(18,6) USING round(("monto"::text)::numeric, 6),
  ALTER COLUMN "saldo" TYPE numeric(18,6) USING round(("saldo"::text)::numeric, 6);

ALTER TABLE "ImportBatch"
  ALTER COLUMN "saldoInicial" TYPE numeric(18,6) USING round(("saldoInicial"::text)::numeric, 6),
  ALTER COLUMN "saldoFinal" TYPE numeric(18,6) USING round(("saldoFinal"::text)::numeric, 6);

ALTER TABLE "ConciliacionBancaria"
  ALTER COLUMN "saldoFinalEstado" TYPE numeric(18,6) USING round(("saldoFinalEstado"::text)::numeric, 6),
  ALTER COLUMN "saldoInicialEstado" TYPE numeric(18,6) USING round(("saldoInicialEstado"::text)::numeric, 6);

ALTER TABLE "ConciliacionDetalle"
  ALTER COLUMN "montoAsignado" TYPE numeric(18,6) USING round(("montoAsignado"::text)::numeric, 6);
