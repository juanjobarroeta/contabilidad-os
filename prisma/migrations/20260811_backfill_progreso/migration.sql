-- CreateTable
CREATE TABLE "BackfillProgreso" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "cursor" TEXT,
    "procesados" INTEGER NOT NULL DEFAULT 0,
    "derivados" INTEGER NOT NULL DEFAULT 0,
    "completadoAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackfillProgreso_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BackfillProgreso_companyId_job_key" ON "BackfillProgreso"("companyId", "job");

-- AddForeignKey
ALTER TABLE "BackfillProgreso" ADD CONSTRAINT "BackfillProgreso_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

