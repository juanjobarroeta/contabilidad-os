-- CreateTable
CREATE TABLE "VehiculoMercado" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vehiculoId" TEXT NOT NULL,
    "consultadoAt" TIMESTAMP(3) NOT NULL,
    "precioMin" DOUBLE PRECISION,
    "precioMax" DOUBLE PRECISION,
    "precioMediana" DOUBLE PRECISION,
    "listados" INTEGER NOT NULL DEFAULT 0,
    "resultados" JSONB,

    CONSTRAINT "VehiculoMercado_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VehiculoMercado_vehiculoId_key" ON "VehiculoMercado"("vehiculoId");

-- CreateIndex
CREATE INDEX "VehiculoMercado_companyId_consultadoAt_idx" ON "VehiculoMercado"("companyId", "consultadoAt");

-- AddForeignKey
ALTER TABLE "VehiculoMercado" ADD CONSTRAINT "VehiculoMercado_vehiculoId_fkey" FOREIGN KEY ("vehiculoId") REFERENCES "Vehiculo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

