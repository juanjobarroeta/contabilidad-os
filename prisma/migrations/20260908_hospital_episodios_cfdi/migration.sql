-- CreateEnum
CREATE TYPE "HospEpisodioOrigen" AS ENUM ('CAPTURA', 'COTIZACION', 'CFDI');

-- AlterTable
ALTER TABLE "HospEpisodio" ADD COLUMN     "origen" "HospEpisodioOrigen" NOT NULL DEFAULT 'CAPTURA';

-- AlterEnum
ALTER TYPE "HospCargoOrigen" ADD VALUE 'CFDI';

