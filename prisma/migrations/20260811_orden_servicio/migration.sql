-- CreateEnum
CREATE TYPE "OrdenServicioEstado" AS ENUM ('RECIBIDA', 'EN_PROCESO', 'LISTA', 'ENTREGADA', 'CANCELADA');

-- CreateEnum
CREATE TYPE "OrdenServicioLineaTipo" AS ENUM ('MANO_OBRA', 'REFACCION');

-- CreateTable
CREATE TABLE "OrdenServicio" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "folio" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "estado" "OrdenServicioEstado" NOT NULL DEFAULT 'RECIBIDA',
    "clienteId" TEXT,
    "vehiculoId" TEXT,
    "vin" TEXT,
    "descripcionUnidad" TEXT,
    "placas" TEXT,
    "kilometraje" INTEGER,
    "fallaReportada" TEXT NOT NULL,
    "diagnostico" TEXT,
    "notas" TEXT,
    "asesorId" TEXT,
    "tecnicoId" TEXT,
    "recibidaAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "prometidaAt" TIMESTAMP(3),
    "enProcesoAt" TIMESTAMP(3),
    "listaAt" TIMESTAMP(3),
    "entregadaAt" TIMESTAMP(3),
    "servicioVentaId" TEXT,

    CONSTRAINT "OrdenServicio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrdenServicioLinea" (
    "id" TEXT NOT NULL,
    "ordenId" TEXT NOT NULL,
    "tipo" "OrdenServicioLineaTipo" NOT NULL,
    "descripcion" TEXT NOT NULL,
    "cantidad" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "precioUnitario" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "refaccionId" TEXT,

    CONSTRAINT "OrdenServicioLinea_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrdenServicio_servicioVentaId_key" ON "OrdenServicio"("servicioVentaId");

-- CreateIndex
CREATE INDEX "OrdenServicio_companyId_estado_idx" ON "OrdenServicio"("companyId", "estado");

-- CreateIndex
CREATE INDEX "OrdenServicio_companyId_clienteId_idx" ON "OrdenServicio"("companyId", "clienteId");

-- CreateIndex
CREATE UNIQUE INDEX "OrdenServicio_companyId_folio_key" ON "OrdenServicio"("companyId", "folio");

-- CreateIndex
CREATE INDEX "OrdenServicioLinea_ordenId_idx" ON "OrdenServicioLinea"("ordenId");

-- AddForeignKey
ALTER TABLE "OrdenServicio" ADD CONSTRAINT "OrdenServicio_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrdenServicio" ADD CONSTRAINT "OrdenServicio_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrdenServicio" ADD CONSTRAINT "OrdenServicio_vehiculoId_fkey" FOREIGN KEY ("vehiculoId") REFERENCES "Vehiculo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrdenServicio" ADD CONSTRAINT "OrdenServicio_asesorId_fkey" FOREIGN KEY ("asesorId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrdenServicio" ADD CONSTRAINT "OrdenServicio_tecnicoId_fkey" FOREIGN KEY ("tecnicoId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrdenServicio" ADD CONSTRAINT "OrdenServicio_servicioVentaId_fkey" FOREIGN KEY ("servicioVentaId") REFERENCES "ServicioVenta"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrdenServicioLinea" ADD CONSTRAINT "OrdenServicioLinea_ordenId_fkey" FOREIGN KEY ("ordenId") REFERENCES "OrdenServicio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrdenServicioLinea" ADD CONSTRAINT "OrdenServicioLinea_refaccionId_fkey" FOREIGN KEY ("refaccionId") REFERENCES "Refaccion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

