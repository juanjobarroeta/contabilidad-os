-- CreateTable
CREATE TABLE "FacturaRecurrente" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "periodicidad" TEXT NOT NULL,
    "diaMes" INTEGER NOT NULL,
    "proximaEmision" TIMESTAMP(3) NOT NULL,
    "fin" TIMESTAMP(3),
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "ultimaEmision" TIMESTAMP(3),
    "generadas" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FacturaRecurrente_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FacturaRecurrente_companyId_activa_idx" ON "FacturaRecurrente"("companyId", "activa");

-- CreateIndex
CREATE INDEX "FacturaRecurrente_activa_proximaEmision_idx" ON "FacturaRecurrente"("activa", "proximaEmision");

-- CreateIndex
CREATE INDEX "FacturaRecurrente_customerId_idx" ON "FacturaRecurrente"("customerId");

-- AddForeignKey
ALTER TABLE "FacturaRecurrente" ADD CONSTRAINT "FacturaRecurrente_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FacturaRecurrente" ADD CONSTRAINT "FacturaRecurrente_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

