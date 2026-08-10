-- CreateEnum
CREATE TYPE "RefaccionMovTipo" AS ENUM ('ENTRADA_COMPRA', 'SALIDA_VENTA', 'AJUSTE');

-- CreateTable
CREATE TABLE "Refaccion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "numeroParte" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "claveProdServ" TEXT,
    "ultimoCosto" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ultimoPrecio" DOUBLE PRECISION,
    "autoCreado" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Refaccion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefaccionMovimiento" (
    "id" TEXT NOT NULL,
    "refaccionId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "tipo" "RefaccionMovTipo" NOT NULL,
    "cantidad" DOUBLE PRECISION NOT NULL,
    "montoUnitario" DOUBLE PRECISION,
    "fecha" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefaccionMovimiento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Refaccion_companyId_descripcion_idx" ON "Refaccion"("companyId", "descripcion");

-- CreateIndex
CREATE UNIQUE INDEX "Refaccion_companyId_numeroParte_key" ON "Refaccion"("companyId", "numeroParte");

-- CreateIndex
CREATE INDEX "RefaccionMovimiento_invoiceId_idx" ON "RefaccionMovimiento"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "RefaccionMovimiento_refaccionId_invoiceId_tipo_key" ON "RefaccionMovimiento"("refaccionId", "invoiceId", "tipo");

-- AddForeignKey
ALTER TABLE "Refaccion" ADD CONSTRAINT "Refaccion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefaccionMovimiento" ADD CONSTRAINT "RefaccionMovimiento_refaccionId_fkey" FOREIGN KEY ("refaccionId") REFERENCES "Refaccion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefaccionMovimiento" ADD CONSTRAINT "RefaccionMovimiento_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

