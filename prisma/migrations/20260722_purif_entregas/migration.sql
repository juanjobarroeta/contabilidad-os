-- CreateEnum
CREATE TYPE "PurifEntregaTipo" AS ENUM ('CASAS', 'EMPRESA', 'CORTESIA');

-- CreateEnum
CREATE TYPE "PurifEntregaEstado" AS ENUM ('REGISTRADO', 'INTEGRADO', 'CANCELADO');

-- CreateTable
CREATE TABLE "PurifEntrega" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha" TIMESTAMP(3) NOT NULL,
    "tipo" "PurifEntregaTipo" NOT NULL,
    "rutaId" TEXT,
    "customerId" TEXT,
    "sucursalId" TEXT,
    "garrafones" INTEGER NOT NULL,
    "importe" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "formaPago" "PurifFormaPago",
    "estado" "PurifEntregaEstado" NOT NULL DEFAULT 'REGISTRADO',
    "notas" TEXT,
    "corteId" TEXT,

    CONSTRAINT "PurifEntrega_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurifEntrega_companyId_fecha_estado_idx" ON "PurifEntrega"("companyId", "fecha", "estado");

-- CreateIndex
CREATE INDEX "PurifEntrega_corteId_idx" ON "PurifEntrega"("corteId");

-- AddForeignKey
ALTER TABLE "PurifEntrega" ADD CONSTRAINT "PurifEntrega_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifEntrega" ADD CONSTRAINT "PurifEntrega_rutaId_fkey" FOREIGN KEY ("rutaId") REFERENCES "PurifRuta"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifEntrega" ADD CONSTRAINT "PurifEntrega_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifEntrega" ADD CONSTRAINT "PurifEntrega_sucursalId_fkey" FOREIGN KEY ("sucursalId") REFERENCES "PurifSucursal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifEntrega" ADD CONSTRAINT "PurifEntrega_corteId_fkey" FOREIGN KEY ("corteId") REFERENCES "PurifCorte"("id") ON DELETE SET NULL ON UPDATE CASCADE;

