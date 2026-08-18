-- AlterTable
ALTER TABLE "FacturaRecurrente" ADD COLUMN     "firma" TEXT;

-- CreateTable
CREATE TABLE "RecurrenteSugerenciaIgnorada" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "firma" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecurrenteSugerenciaIgnorada_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecurrenteSugerenciaIgnorada_companyId_firma_key" ON "RecurrenteSugerenciaIgnorada"("companyId", "firma");

-- CreateIndex
CREATE INDEX "FacturaRecurrente_companyId_firma_idx" ON "FacturaRecurrente"("companyId", "firma");

-- AddForeignKey
ALTER TABLE "RecurrenteSugerenciaIgnorada" ADD CONSTRAINT "RecurrenteSugerenciaIgnorada_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

