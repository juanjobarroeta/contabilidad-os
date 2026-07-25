-- CreateEnum
CREATE TYPE "ConstruccionRol" AS ENUM ('ADMIN', 'TESORERIA', 'RESIDENTE');

-- AlterTable
ALTER TABLE "CompanyMember" ADD COLUMN     "construccionRol" "ConstruccionRol";
