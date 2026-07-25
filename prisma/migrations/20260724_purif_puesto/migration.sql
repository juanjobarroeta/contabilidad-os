-- CreateEnum
CREATE TYPE "PurifPuesto" AS ENUM ('VENTANILLA', 'REPARTO', 'AMBOS');

-- AlterTable
ALTER TABLE "CompanyMember" ADD COLUMN     "purifPuesto" "PurifPuesto";

