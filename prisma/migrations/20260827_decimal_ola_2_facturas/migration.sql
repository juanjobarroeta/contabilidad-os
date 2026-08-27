-- Float → Decimal, Ola 2: facturas (docs/FLOAT-DECIMAL.md).
-- float8 → numeric(18,6) VÍA TEXTO — el cast directo float8::numeric trunca
-- a 15 dígitos significativos (lección del ensayo de la Ola 1); float8::text
-- imprime la representación más corta que round-tripea, exactamente lo que
-- la app siempre vio. NaN/Infinity revientan el parse: dinero no-finito
-- frena la migración. Un solo ALTER por tabla = una sola reescritura.
-- Invoice es la tabla grande del sistema: esta migración corre en el
-- preDeployCommand; si falla, el deploy aborta y la imagen anterior sigue.

ALTER TABLE "Invoice"
  ALTER COLUMN "tipoCambio" TYPE numeric(18,6) USING round(("tipoCambio"::text)::numeric, 6),
  ALTER COLUMN "subtotal" TYPE numeric(18,6) USING round(("subtotal"::text)::numeric, 6),
  ALTER COLUMN "descuento" TYPE numeric(18,6) USING round(("descuento"::text)::numeric, 6),
  ALTER COLUMN "totalImpuestos" TYPE numeric(18,6) USING round(("totalImpuestos"::text)::numeric, 6),
  ALTER COLUMN "total" TYPE numeric(18,6) USING round(("total"::text)::numeric, 6),
  ALTER COLUMN "isrRetenidoNomina" TYPE numeric(18,6) USING round(("isrRetenidoNomina"::text)::numeric, 6);

ALTER TABLE "InvoiceItem"
  ALTER COLUMN "cantidad" TYPE numeric(18,6) USING round(("cantidad"::text)::numeric, 6),
  ALTER COLUMN "valorUnitario" TYPE numeric(18,6) USING round(("valorUnitario"::text)::numeric, 6),
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6),
  ALTER COLUMN "descuento" TYPE numeric(18,6) USING round(("descuento"::text)::numeric, 6);

ALTER TABLE "InvoiceTax"
  ALTER COLUMN "tasa" TYPE numeric(18,6) USING round(("tasa"::text)::numeric, 6),
  ALTER COLUMN "base" TYPE numeric(18,6) USING round(("base"::text)::numeric, 6),
  ALTER COLUMN "importe" TYPE numeric(18,6) USING round(("importe"::text)::numeric, 6);

ALTER TABLE "PagoDoctoRelacionado"
  ALTER COLUMN "impPagado" TYPE numeric(18,6) USING round(("impPagado"::text)::numeric, 6),
  ALTER COLUMN "impSaldoAnterior" TYPE numeric(18,6) USING round(("impSaldoAnterior"::text)::numeric, 6),
  ALTER COLUMN "impSaldoInsoluto" TYPE numeric(18,6) USING round(("impSaldoInsoluto"::text)::numeric, 6),
  ALTER COLUMN "baseTraslado" TYPE numeric(18,6) USING round(("baseTraslado"::text)::numeric, 6),
  ALTER COLUMN "ivaTrasladado" TYPE numeric(18,6) USING round(("ivaTrasladado"::text)::numeric, 6);

ALTER TABLE "FacturaBorrador"
  ALTER COLUMN "total" TYPE numeric(18,6) USING round(("total"::text)::numeric, 6);

ALTER TABLE "CfdiFaltante"
  ALTER COLUMN "total" TYPE numeric(18,6) USING round(("total"::text)::numeric, 6);

ALTER TABLE "FacturaRecurrente"
  ALTER COLUMN "total" TYPE numeric(18,6) USING round(("total"::text)::numeric, 6);

ALTER TABLE "IvaPeriodNotice"
  ALTER COLUMN "ivaTrasladado" TYPE numeric(18,6) USING round(("ivaTrasladado"::text)::numeric, 6);
