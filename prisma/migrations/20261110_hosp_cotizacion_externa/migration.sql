-- Cotización hecha fuera del sistema y subida tal cual.
ALTER TABLE "HospCotizacion" ADD COLUMN "externa" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "HospCotizacion" ADD COLUMN "folioExterno" TEXT;

CREATE TABLE "HospCotizacionArchivo" (
    "id" TEXT NOT NULL,
    "cotizacionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nombre" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "archivo" BYTEA NOT NULL,
    CONSTRAINT "HospCotizacionArchivo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HospCotizacionArchivo_cotizacionId_key" ON "HospCotizacionArchivo"("cotizacionId");
ALTER TABLE "HospCotizacionArchivo" ADD CONSTRAINT "HospCotizacionArchivo_cotizacionId_fkey" FOREIGN KEY ("cotizacionId") REFERENCES "HospCotizacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
