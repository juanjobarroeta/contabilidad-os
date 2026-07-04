-- Cuenta corriente del proveedor: pagos + aplicaciones (Fase A)

-- CreateTable
CREATE TABLE "construccion_pago_proveedor" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "supplierId" TEXT,
    "supplierNombre" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "monto" DOUBLE PRECISION NOT NULL,
    "referencia" TEXT,
    "comprobanteData" TEXT,
    "comprobanteMime" TEXT,
    "comprobanteName" TEXT,
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "construccion_pago_proveedor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "construccion_pago_aplicacion" (
    "id" TEXT NOT NULL,
    "pagoId" TEXT NOT NULL,
    "adjudicacionId" TEXT NOT NULL,
    "monto" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "construccion_pago_aplicacion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "construccion_pago_proveedor_companyId_supplierId_idx" ON "construccion_pago_proveedor"("companyId", "supplierId");

-- CreateIndex
CREATE INDEX "construccion_pago_proveedor_companyId_fecha_idx" ON "construccion_pago_proveedor"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "construccion_pago_aplicacion_adjudicacionId_idx" ON "construccion_pago_aplicacion"("adjudicacionId");

-- CreateIndex
CREATE UNIQUE INDEX "construccion_pago_aplicacion_pagoId_adjudicacionId_key" ON "construccion_pago_aplicacion"("pagoId", "adjudicacionId");

-- AddForeignKey
ALTER TABLE "construccion_pago_proveedor" ADD CONSTRAINT "construccion_pago_proveedor_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construccion_pago_aplicacion" ADD CONSTRAINT "construccion_pago_aplicacion_pagoId_fkey" FOREIGN KEY ("pagoId") REFERENCES "construccion_pago_proveedor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "construccion_pago_aplicacion" ADD CONSTRAINT "construccion_pago_aplicacion_adjudicacionId_fkey" FOREIGN KEY ("adjudicacionId") REFERENCES "construccion_solicitud_adjudicacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
