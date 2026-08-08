-- CreateTable
CREATE TABLE "AutomotrizConfig" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "planPisoTasaAnual" DOUBLE PRECISION,
    "comisionPorcentajeUtilidad" DOUBLE PRECISION,
    "comisionFija" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomotrizConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutomotrizConfig_companyId_key" ON "AutomotrizConfig"("companyId");

-- AddForeignKey
ALTER TABLE "AutomotrizConfig" ADD CONSTRAINT "AutomotrizConfig_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

