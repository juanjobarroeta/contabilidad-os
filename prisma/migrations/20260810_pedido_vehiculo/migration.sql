-- CreateEnum
CREATE TYPE "PedidoVehiculoEstado" AS ENUM ('COTIZACION', 'APARTADO', 'FACTURADO', 'ENTREGADO', 'CANCELADO');

-- CreateTable
CREATE TABLE "PedidoVehiculo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "vehiculoId" TEXT NOT NULL,
    "clienteId" TEXT NOT NULL,
    "vendedorId" TEXT,
    "estado" "PedidoVehiculoEstado" NOT NULL DEFAULT 'COTIZACION',
    "precio" DOUBLE PRECISION NOT NULL,
    "enganche" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "anticipoRecibido" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tomaACuentaDesc" TEXT,
    "tomaACuentaMonto" DOUBLE PRECISION,
    "financiamiento" TEXT,
    "notas" TEXT,
    "apartadoAt" TIMESTAMP(3),
    "facturadoAt" TIMESTAMP(3),
    "entregadoAt" TIMESTAMP(3),

    CONSTRAINT "PedidoVehiculo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PedidoVehiculo_companyId_estado_idx" ON "PedidoVehiculo"("companyId", "estado");

-- AddForeignKey
ALTER TABLE "PedidoVehiculo" ADD CONSTRAINT "PedidoVehiculo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PedidoVehiculo" ADD CONSTRAINT "PedidoVehiculo_vehiculoId_fkey" FOREIGN KEY ("vehiculoId") REFERENCES "Vehiculo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PedidoVehiculo" ADD CONSTRAINT "PedidoVehiculo_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PedidoVehiculo" ADD CONSTRAINT "PedidoVehiculo_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

