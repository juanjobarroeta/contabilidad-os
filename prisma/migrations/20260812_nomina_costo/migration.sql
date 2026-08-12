-- CreateEnum
CREATE TYPE "LineaNegocio" AS ENUM ('TALLER', 'VENTAS', 'REFACCIONES', 'ADMIN');

-- CreateTable
CREATE TABLE "NominaCosto" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sucursal" TEXT,
    "puesto" TEXT,
    "linea" "LineaNegocio" NOT NULL,
    "percepciones" DOUBLE PRECISION NOT NULL,
    "cuotasPatronales" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sbcDiario" DOUBLE PRECISION,
    "diasPagados" INTEGER,
    "riesgoPuesto" TEXT,
    "lineaManual" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "NominaCosto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NominaCosto_invoiceId_key" ON "NominaCosto"("invoiceId");

-- CreateIndex
CREATE INDEX "NominaCosto_companyId_fecha_idx" ON "NominaCosto"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "NominaCosto_companyId_linea_idx" ON "NominaCosto"("companyId", "linea");

-- AddForeignKey
ALTER TABLE "NominaCosto" ADD CONSTRAINT "NominaCosto_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NominaCosto" ADD CONSTRAINT "NominaCosto_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

