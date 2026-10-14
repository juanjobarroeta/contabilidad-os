-- Farmacia con escáner: códigos de barras por insumo, conteo físico por
-- sesión y el precio máximo al público del lote. Aditiva.
ALTER TABLE "HospLote" ADD COLUMN IF NOT EXISTS "precioMaximoPublico" DECIMAL(18,6);

CREATE TABLE IF NOT EXISTS "HospCodigoBarras" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "insumoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gtin" TEXT NOT NULL,
    "original" TEXT NOT NULL,
    "creadoPorNombre" TEXT,
    CONSTRAINT "HospCodigoBarras_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HospCodigoBarras_companyId_gtin_key" ON "HospCodigoBarras"("companyId", "gtin");
CREATE INDEX IF NOT EXISTS "HospCodigoBarras_insumoId_idx" ON "HospCodigoBarras"("insumoId");
ALTER TABLE "HospCodigoBarras" ADD CONSTRAINT "HospCodigoBarras_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HospCodigoBarras" ADD CONSTRAINT "HospCodigoBarras_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "HospInsumo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "HospConteo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "almacen" TEXT NOT NULL DEFAULT 'GENERAL',
    "estado" TEXT NOT NULL DEFAULT 'ABIERTO',
    "notas" TEXT,
    "iniciadoPorId" TEXT,
    "iniciadoPorNombre" TEXT,
    "cerradoAt" TIMESTAMP(3),
    "cerradoPorNombre" TEXT,
    "faltantesEnCero" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "HospConteo_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "HospConteo_companyId_estado_idx" ON "HospConteo"("companyId", "estado");
ALTER TABLE "HospConteo" ADD CONSTRAINT "HospConteo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "HospConteoLinea" (
    "id" TEXT NOT NULL,
    "conteoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "insumoId" TEXT NOT NULL,
    "loteId" TEXT,
    "lote" TEXT NOT NULL,
    "caducidad" TIMESTAMP(3),
    "cantidad" DECIMAL(18,6) NOT NULL,
    "escaneadoPorNombre" TEXT,
    CONSTRAINT "HospConteoLinea_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HospConteoLinea_conteoId_insumoId_lote_key" ON "HospConteoLinea"("conteoId", "insumoId", "lote");
CREATE INDEX IF NOT EXISTS "HospConteoLinea_conteoId_idx" ON "HospConteoLinea"("conteoId");
ALTER TABLE "HospConteoLinea" ADD CONSTRAINT "HospConteoLinea_conteoId_fkey" FOREIGN KEY ("conteoId") REFERENCES "HospConteo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HospConteoLinea" ADD CONSTRAINT "HospConteoLinea_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "HospInsumo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HospConteoLinea" ADD CONSTRAINT "HospConteoLinea_loteId_fkey" FOREIGN KEY ("loteId") REFERENCES "HospLote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
