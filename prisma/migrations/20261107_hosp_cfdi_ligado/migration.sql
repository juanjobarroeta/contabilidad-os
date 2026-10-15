-- El CFDI de compra ya no crea inventario: sus renglones se ligan al catálogo
-- físico (HospCfdiLinea) y se aprende la clave del proveedor (HospProveedorInsumo). Aditiva.
-- AlterTable
ALTER TABLE "HospConfig" ADD COLUMN     "cfdiCreaInventario" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "HospCfdiLinea" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "llave" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "noIdentificacion" TEXT,
    "claveProdServ" TEXT,
    "claveUnidad" TEXT,
    "cantidad" DECIMAL(18,6) NOT NULL,
    "importe" DECIMAL(18,6) NOT NULL,
    "proveedorRfc" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'POR_LIGAR',
    "origen" TEXT,
    "insumoId" TEXT,
    "solicitudPartidaId" TEXT,
    "ligadoPorId" TEXT,
    "ligadoAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospCfdiLinea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospProveedorInsumo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "proveedorRfc" TEXT NOT NULL,
    "claveProveedor" TEXT NOT NULL,
    "insumoId" TEXT NOT NULL,
    "creadoPorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospProveedorInsumo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HospCfdiLinea_companyId_estado_idx" ON "HospCfdiLinea"("companyId", "estado");

-- CreateIndex
CREATE INDEX "HospCfdiLinea_insumoId_idx" ON "HospCfdiLinea"("insumoId");

-- CreateIndex
CREATE INDEX "HospCfdiLinea_solicitudPartidaId_idx" ON "HospCfdiLinea"("solicitudPartidaId");

-- CreateIndex
CREATE UNIQUE INDEX "HospCfdiLinea_invoiceId_llave_key" ON "HospCfdiLinea"("invoiceId", "llave");

-- CreateIndex
CREATE INDEX "HospProveedorInsumo_insumoId_idx" ON "HospProveedorInsumo"("insumoId");

-- CreateIndex
CREATE UNIQUE INDEX "HospProveedorInsumo_companyId_proveedorRfc_claveProveedor_key" ON "HospProveedorInsumo"("companyId", "proveedorRfc", "claveProveedor");

-- AddForeignKey
ALTER TABLE "HospCfdiLinea" ADD CONSTRAINT "HospCfdiLinea_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCfdiLinea" ADD CONSTRAINT "HospCfdiLinea_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCfdiLinea" ADD CONSTRAINT "HospCfdiLinea_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "HospInsumo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCfdiLinea" ADD CONSTRAINT "HospCfdiLinea_solicitudPartidaId_fkey" FOREIGN KEY ("solicitudPartidaId") REFERENCES "SolicitudPartida"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospProveedorInsumo" ADD CONSTRAINT "HospProveedorInsumo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospProveedorInsumo" ADD CONSTRAINT "HospProveedorInsumo_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "HospInsumo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

