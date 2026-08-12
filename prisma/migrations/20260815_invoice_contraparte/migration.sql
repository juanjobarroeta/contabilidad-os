-- Contraparte del CFDI denormalizada en la factura. El nombre viene en el XML
-- (cfdi:Receptor/@Nombre o cfdi:Emisor/@Nombre) pero sólo se guardaba cuando se
-- creaba un Customer — y a público en general (XAXX010101000) y extranjeros
-- (XEXX010101000) NO se les crea Customer a propósito, así que la lista de
-- comprobantes mostraba "—" aunque el nombre estuviera en el comprobante.
ALTER TABLE "Invoice"
  ADD COLUMN "contraparteNombre" TEXT,
  ADD COLUMN "contraparteRfc" TEXT;
