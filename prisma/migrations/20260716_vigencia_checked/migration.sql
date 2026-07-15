-- Cursor del barrido de vigencia por UUID (cron sat-vigencia-sync). Aditivo.
ALTER TABLE "Invoice" ADD COLUMN "vigenciaCheckedAt" TIMESTAMP(3);
