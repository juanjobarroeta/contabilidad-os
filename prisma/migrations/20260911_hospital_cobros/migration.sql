-- CreateEnum
CREATE TYPE "HospCobroEstado" AS ENUM ('COBRADO', 'DEPOSITADO', 'CONTRACARGADO', 'RECUPERADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "HospTarjetaMarca" AS ENUM ('VISA', 'MASTERCARD', 'AMEX', 'CARNET', 'OTRA');

-- CreateEnum
CREATE TYPE "HospTarjetaTipo" AS ENUM ('CREDITO', 'DEBITO');

-- CreateTable
CREATE TABLE "HospAfiliacion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "numero" TEXT NOT NULL,
    "descripcion" TEXT,
    "adquirente" TEXT,
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "tasa" DECIMAL(6,4),

    CONSTRAINT "HospAfiliacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospCobro" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha" TIMESTAMP(3) NOT NULL,
    "monto" DECIMAL(18,2) NOT NULL,
    "formaPago" "HospFormaPago" NOT NULL,
    "estado" "HospCobroEstado" NOT NULL DEFAULT 'COBRADO',
    "episodioId" TEXT,
    "invoiceId" TEXT,
    "depositoId" TEXT,
    "afiliacionId" TEXT,
    "autorizacion" TEXT,
    "marca" "HospTarjetaMarca",
    "tipoTarjeta" "HospTarjetaTipo",
    "ultimos4" TEXT,
    "referencia" TEXT,
    "liquidacionId" TEXT,
    "depositadoAt" TIMESTAMP(3),
    "contracargoAt" TIMESTAMP(3),
    "contracargoMotivo" TEXT,
    "recuperadoAt" TIMESTAMP(3),
    "asientoAt" TIMESTAMP(3),
    "cobradoPorUserId" TEXT,
    "notas" TEXT,

    CONSTRAINT "HospCobro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospLiquidacion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "afiliacionId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "bruto" DECIMAL(18,2) NOT NULL,
    "contracargos" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "comision" DECIMAL(18,2) NOT NULL,
    "ivaComision" DECIMAL(18,2) NOT NULL,
    "neto" DECIMAL(18,2) NOT NULL,
    "bankTransactionId" TEXT,
    "conciliadoAt" TIMESTAMP(3),
    "asientoAt" TIMESTAMP(3),
    "notas" TEXT,

    CONSTRAINT "HospLiquidacion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HospAfiliacion_companyId_activa_idx" ON "HospAfiliacion"("companyId", "activa");

-- CreateIndex
CREATE UNIQUE INDEX "HospAfiliacion_companyId_numero_key" ON "HospAfiliacion"("companyId", "numero");

-- CreateIndex
CREATE UNIQUE INDEX "HospCobro_depositoId_key" ON "HospCobro"("depositoId");

-- CreateIndex
CREATE INDEX "HospCobro_companyId_fecha_idx" ON "HospCobro"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "HospCobro_companyId_estado_idx" ON "HospCobro"("companyId", "estado");

-- CreateIndex
CREATE INDEX "HospCobro_companyId_afiliacionId_fecha_idx" ON "HospCobro"("companyId", "afiliacionId", "fecha");

-- CreateIndex
CREATE INDEX "HospCobro_episodioId_idx" ON "HospCobro"("episodioId");

-- CreateIndex
CREATE INDEX "HospCobro_liquidacionId_idx" ON "HospCobro"("liquidacionId");

-- CreateIndex
CREATE UNIQUE INDEX "HospLiquidacion_bankTransactionId_key" ON "HospLiquidacion"("bankTransactionId");

-- CreateIndex
CREATE INDEX "HospLiquidacion_companyId_fecha_idx" ON "HospLiquidacion"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "HospLiquidacion_afiliacionId_fecha_idx" ON "HospLiquidacion"("afiliacionId", "fecha");

-- AddForeignKey
ALTER TABLE "HospAfiliacion" ADD CONSTRAINT "HospAfiliacion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCobro" ADD CONSTRAINT "HospCobro_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCobro" ADD CONSTRAINT "HospCobro_episodioId_fkey" FOREIGN KEY ("episodioId") REFERENCES "HospEpisodio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCobro" ADD CONSTRAINT "HospCobro_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCobro" ADD CONSTRAINT "HospCobro_depositoId_fkey" FOREIGN KEY ("depositoId") REFERENCES "HospDeposito"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCobro" ADD CONSTRAINT "HospCobro_afiliacionId_fkey" FOREIGN KEY ("afiliacionId") REFERENCES "HospAfiliacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospCobro" ADD CONSTRAINT "HospCobro_liquidacionId_fkey" FOREIGN KEY ("liquidacionId") REFERENCES "HospLiquidacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospLiquidacion" ADD CONSTRAINT "HospLiquidacion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospLiquidacion" ADD CONSTRAINT "HospLiquidacion_afiliacionId_fkey" FOREIGN KEY ("afiliacionId") REFERENCES "HospAfiliacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospLiquidacion" ADD CONSTRAINT "HospLiquidacion_bankTransactionId_fkey" FOREIGN KEY ("bankTransactionId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

