-- CreateEnum
CREATE TYPE "ProspectoMedio" AS ENUM ('PISO', 'TELEFONO', 'DIGITAL', 'REFERIDO', 'OTRO');

-- CreateEnum
CREATE TYPE "ProspectoEstado" AS ENUM ('NUEVO', 'CONTACTADO', 'CITA', 'DEMO', 'NEGOCIACION', 'GANADO', 'PERDIDO');

-- CreateTable
CREATE TABLE "Prospecto" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "nombre" TEXT NOT NULL,
    "telefono" TEXT,
    "email" TEXT,
    "medio" "ProspectoMedio" NOT NULL DEFAULT 'PISO',
    "estado" "ProspectoEstado" NOT NULL DEFAULT 'NUEVO',
    "interes" TEXT,
    "vehiculoId" TEXT,
    "vendedorId" TEXT,
    "proximaAccion" TIMESTAMP(3),
    "proximaNota" TEXT,
    "notas" TEXT,
    "clienteId" TEXT,
    "pedidoId" TEXT,
    "perdidoMotivo" TEXT,
    "ganadoAt" TIMESTAMP(3),
    "perdidoAt" TIMESTAMP(3),

    CONSTRAINT "Prospecto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Prospecto_pedidoId_key" ON "Prospecto"("pedidoId");

-- CreateIndex
CREATE INDEX "Prospecto_companyId_estado_idx" ON "Prospecto"("companyId", "estado");

-- CreateIndex
CREATE INDEX "Prospecto_companyId_proximaAccion_idx" ON "Prospecto"("companyId", "proximaAccion");

-- AddForeignKey
ALTER TABLE "Prospecto" ADD CONSTRAINT "Prospecto_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prospecto" ADD CONSTRAINT "Prospecto_vehiculoId_fkey" FOREIGN KEY ("vehiculoId") REFERENCES "Vehiculo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prospecto" ADD CONSTRAINT "Prospecto_vendedorId_fkey" FOREIGN KEY ("vendedorId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prospecto" ADD CONSTRAINT "Prospecto_clienteId_fkey" FOREIGN KEY ("clienteId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prospecto" ADD CONSTRAINT "Prospecto_pedidoId_fkey" FOREIGN KEY ("pedidoId") REFERENCES "PedidoVehiculo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

