-- VehiculoCosto.autoCreado: ¿lo escribió el derivador desde un CFDI, o lo
-- capturó una persona?
--
-- Sin esta marca no se puede volver a derivar una factura sin arriesgarse a
-- borrar un costo tecleado a mano — y no volver a derivarla es lo que dejó
-- $31.2M de filas rancias en MARGOM, con tres generaciones de extracción de VIN
-- encimadas sobre la misma factura.
ALTER TABLE "VehiculoCosto" ADD COLUMN "autoCreado" BOOLEAN NOT NULL DEFAULT false;

-- Backfill de procedencia. El derivador SIEMPRE escribe invoiceId; la captura
-- manual normalmente lo deja nulo (la UI permite ligar un CFDI, pero es el caso
-- raro). Marcar por invoiceId es la mejor señal disponible en los datos.
--
-- El riesgo residual es acotado y va en una sola dirección: un costo capturado
-- a mano Y ligado a un CFDI queda marcado como automático, y una re-derivación
-- futura de ESA factura lo reemplazaría. Antes de correr la limpieza masiva hay
-- que contar cuántos son — la limpieza es el paso destructivo, no éste.
UPDATE "VehiculoCosto" SET "autoCreado" = true WHERE "invoiceId" IS NOT NULL;
