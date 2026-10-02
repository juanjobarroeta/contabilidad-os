-- IVA por línea en las requisiciones de construcción.
--
-- SolicitudPartida.ivaTasa: convención de la casa — null = exento, 0 = tasa
-- 0 %, 0.16 = gravado. El DEFAULT rellena las líneas existentes con 0.16, que
-- es justo lo que la UI siempre supuso (multiplicaba ×1.16 a todo).
--
-- SolicitudAdjudicacion.subtotal / iva: desglose del pagable. Nullable: las
-- adjudicaciones existentes y las de hospital quedan sin desglose y su total
-- no cambia — esta migración no toca ningún monto ya registrado.

-- AlterTable
ALTER TABLE "SolicitudPartida" ADD COLUMN     "ivaTasa" DECIMAL(18,6) DEFAULT 0.16;

-- AlterTable
ALTER TABLE "construccion_solicitud_adjudicacion" ADD COLUMN     "iva" DECIMAL(18,6),
ADD COLUMN     "subtotal" DECIMAL(18,6);
