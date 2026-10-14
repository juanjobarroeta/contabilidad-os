-- El pedido se manda por proveedor: pasa de la requisición a cada orden (adjudicación).
ALTER TABLE "construccion_solicitud_adjudicacion" ADD COLUMN     "pedidoEnviadoAt" TIMESTAMP(3),
ADD COLUMN     "pedidoEnviadoPorId" TEXT,
ADD COLUMN     "pedidoEnviadoVia" TEXT;

UPDATE "construccion_solicitud_adjudicacion" a
SET "pedidoEnviadoAt" = s."pedidoEnviadoAt", "pedidoEnviadoVia" = s."pedidoEnviadoVia", "pedidoEnviadoPorId" = s."pedidoEnviadoPorId"
FROM "SolicitudCompra" s
WHERE a."solicitudId" = s.id AND s."pedidoEnviadoAt" IS NOT NULL;

ALTER TABLE "SolicitudCompra" DROP COLUMN "pedidoEnviadoAt",
DROP COLUMN "pedidoEnviadoPorId",
DROP COLUMN "pedidoEnviadoVia";

-- Proveedor que sugiere el área.
ALTER TABLE "HospSolicitudAreaLinea" ADD COLUMN     "proveedorSugeridoId" TEXT,
ADD COLUMN     "proveedorSugeridoNombre" TEXT;
