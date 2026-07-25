-- CreateEnum
CREATE TYPE "ComprobanteTipo" AS ENUM ('NOTA', 'FACTURA');

-- DropForeignKey: proyectoId pasa de requerido a opcional, lo que cambia la
-- acción referencial implícita (RESTRICT → SET NULL)
ALTER TABLE "Gasto" DROP CONSTRAINT "Gasto_proyectoId_fkey";

-- AlterTable: gasto general (sin obra) + proveedor + tipo de comprobante
ALTER TABLE "Gasto" ALTER COLUMN "proyectoId" DROP NOT NULL;
ALTER TABLE "Gasto" ADD COLUMN     "supplierId" TEXT;
ALTER TABLE "Gasto" ADD COLUMN     "comprobanteTipo" "ComprobanteTipo";

-- CreateIndex
CREATE INDEX "Gasto_supplierId_idx" ON "Gasto"("supplierId");

-- AddForeignKey
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_proyectoId_fkey" FOREIGN KEY ("proyectoId") REFERENCES "Proyecto"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Gasto" ADD CONSTRAINT "Gasto_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
