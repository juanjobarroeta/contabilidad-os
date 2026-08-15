-- ¿Hay PDF aunque no haya XML?
--
-- Un PDF NO es un CFDI: no se re-timbra, no se manda al SAT, y sacarle números
-- por OCR sería fabricar datos contables a partir de una imagen. Por eso nunca
-- alimenta totales, impuestos ni el padrón de vehículos.
--
-- Pero como EVIDENCIA vale. Para el contador y para una auditoría, «aquí está
-- el documento, sólo que no es legible por máquina» es muy distinto de «sabemos
-- que existe y no tenemos nada». La bandera viene en el listado del proveedor,
-- así que saber dónde hay evidencia no cuesta una sola descarga.
--
-- `origenId` guarda el id del comprobante en el proveedor para poder pedir ese
-- PDF cuando alguien lo necesite — bajo demanda, no en bloque.

ALTER TABLE "CfdiFaltante" ADD COLUMN "tienePdf" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CfdiFaltante" ADD COLUMN "origenId" TEXT;
