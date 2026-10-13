-- Reportes de facturas pedidos a Mochi: filtros resueltos y el resumen
-- enseñado en el chat. Tabla nueva, sin tocar datos.
CREATE TABLE IF NOT EXISTS "ReporteFacturas" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "origen" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "filtros" JSONB NOT NULL,
    "customerIds" TEXT[],
    "resumen" JSONB NOT NULL,

    CONSTRAINT "ReporteFacturas_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ReporteFacturas_companyId_createdAt_idx" ON "ReporteFacturas"("companyId", "createdAt");

ALTER TABLE "ReporteFacturas" ADD CONSTRAINT "ReporteFacturas_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
