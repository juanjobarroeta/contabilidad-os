-- Historia de la cotización: foto del protocolo/paquete de origen y versiones
-- de cada guardado. Tablas nuevas; las cotizaciones existentes no cambian.
CREATE TABLE IF NOT EXISTS "HospCotizacionOrigen" (
    "id" TEXT NOT NULL,
    "cotizacionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "protocoloId" TEXT,
    "protocoloClave" TEXT,
    "protocoloNombre" TEXT NOT NULL,
    "protocoloVersion" INTEGER,
    "pagadorId" TEXT,
    "precioPaquete" DECIMAL(18,6),
    "totalLista" DECIMAL(18,6) NOT NULL,
    "total" DECIMAL(18,6) NOT NULL,
    "partidas" JSONB NOT NULL,
    CONSTRAINT "HospCotizacionOrigen_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HospCotizacionOrigen_cotizacionId_key" ON "HospCotizacionOrigen"("cotizacionId");
ALTER TABLE "HospCotizacionOrigen" ADD CONSTRAINT "HospCotizacionOrigen_cotizacionId_fkey" FOREIGN KEY ("cotizacionId") REFERENCES "HospCotizacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "HospCotizacionVersion" (
    "id" TEXT NOT NULL,
    "cotizacionId" TEXT NOT NULL,
    "numero" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "userNombre" TEXT,
    "motivo" TEXT,
    "reconstruida" BOOLEAN NOT NULL DEFAULT false,
    "precioPaquete" DECIMAL(18,6),
    "totalLista" DECIMAL(18,6) NOT NULL,
    "subtotal" DECIMAL(18,6) NOT NULL,
    "iva" DECIMAL(18,6) NOT NULL,
    "total" DECIMAL(18,6) NOT NULL,
    "partidas" JSONB NOT NULL,
    CONSTRAINT "HospCotizacionVersion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "HospCotizacionVersion_cotizacionId_numero_key" ON "HospCotizacionVersion"("cotizacionId", "numero");
ALTER TABLE "HospCotizacionVersion" ADD CONSTRAINT "HospCotizacionVersion_cotizacionId_fkey" FOREIGN KEY ("cotizacionId") REFERENCES "HospCotizacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
