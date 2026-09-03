-- Inventario periódico (Fase 1): costo de venta derivado del conteo físico.

-- AlterEnum
ALTER TYPE "EntrySource" ADD VALUE 'INVENTARIO';

-- CreateTable
CREATE TABLE "InventarioConteo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "valorFinal" DECIMAL(18,2) NOT NULL,
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventarioConteo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InventarioConteo_companyId_year_month_key" ON "InventarioConteo"("companyId", "year", "month");

-- AddForeignKey
ALTER TABLE "InventarioConteo" ADD CONSTRAINT "InventarioConteo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
