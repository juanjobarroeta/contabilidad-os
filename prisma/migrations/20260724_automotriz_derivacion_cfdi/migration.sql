-- AlterTable
ALTER TABLE "Vehiculo" ADD COLUMN     "autoCreado" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "claveVehicular" TEXT,
ADD COLUMN     "descripcionCfdi" TEXT;

