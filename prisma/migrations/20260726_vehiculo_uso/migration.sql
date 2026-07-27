-- CreateEnum
CREATE TYPE "VehiculoUso" AS ENUM ('VENTA', 'DEMO', 'CORTESIA');

-- AlterTable
ALTER TABLE "Vehiculo" ADD COLUMN     "uso" "VehiculoUso" NOT NULL DEFAULT 'VENTA';

