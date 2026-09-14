-- Invoice.tipoCorrida: qué corrida es el recibo de nómina (ORDINARIA |
-- EXTRAORDINARIA | FINIQUITO | AGUINALDO | PTU), derivado del complemento.
-- El schema lo agregó #1057 sin migración; el deploy corre `migrate deploy`,
-- así que en producción la columna no existía y todo findMany de Invoice
-- fallaba (Impuestos, cierre, dashboard, copiloto). Fixes CONTABILIDAD-OS-E.
ALTER TABLE "Invoice" ADD COLUMN "tipoCorrida" TEXT;
