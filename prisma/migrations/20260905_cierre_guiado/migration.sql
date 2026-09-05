-- Cierre guiado (PRO): estado del cierre por empresa y periodo, decisión
-- humana por paso con hash de evidencia, y ledger de avisos del pase diario.

-- CreateEnum
CREATE TYPE "EstadoPasoCierre" AS ENUM ('PENDIENTE', 'CONFIRMADO', 'OMITIDO', 'REVISAR');

-- AlterTable: la conversación del periodo (modo="cierre")
ALTER TABLE "ChatConversation" ADD COLUMN "modo" TEXT,
ADD COLUMN "periodo" TEXT,
ADD COLUMN "pasoActivo" TEXT;

-- CreateIndex
CREATE INDEX "ChatConversation_companyId_modo_periodo_idx" ON "ChatConversation"("companyId", "modo", "periodo");

-- CreateTable
CREATE TABLE "CierrePeriodo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "responsableUserId" TEXT,
    "conversationId" TEXT,
    "snapshot" JSONB,
    "snapshotAvance" JSONB,
    "ultimoAvanceAt" TIMESTAMP(3),
    "cerradoAt" TIMESTAMP(3),
    "cerradoByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CierrePeriodo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasoCierre" (
    "id" TEXT NOT NULL,
    "cierreId" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "estadoCalculado" TEXT NOT NULL,
    "detalle" TEXT,
    "hechos" JSONB NOT NULL,
    "hashEvidencia" TEXT NOT NULL,
    "estado" "EstadoPasoCierre" NOT NULL DEFAULT 'PENDIENTE',
    "confirmadoAt" TIMESTAMP(3),
    "confirmadoByUserId" TEXT,
    "hashConfirmado" TEXT,
    "nota" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PasoCierre_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CierreAviso" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "paso" TEXT NOT NULL,
    "deltaKey" TEXT NOT NULL,
    "canales" TEXT[],
    "plantilla" BOOLEAN NOT NULL DEFAULT true,
    "titulo" TEXT NOT NULL,
    "cuerpo" TEXT NOT NULL,
    "enviadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accionadoAt" TIMESTAMP(3),

    CONSTRAINT "CierreAviso_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CierrePeriodo_conversationId_key" ON "CierrePeriodo"("conversationId");
CREATE UNIQUE INDEX "CierrePeriodo_companyId_year_month_key" ON "CierrePeriodo"("companyId", "year", "month");
CREATE INDEX "CierrePeriodo_companyId_cerradoAt_idx" ON "CierrePeriodo"("companyId", "cerradoAt");
CREATE UNIQUE INDEX "PasoCierre_cierreId_clave_key" ON "PasoCierre"("cierreId", "clave");
CREATE INDEX "PasoCierre_clave_estado_idx" ON "PasoCierre"("clave", "estado");
CREATE INDEX "CierreAviso_companyId_periodo_paso_idx" ON "CierreAviso"("companyId", "periodo", "paso");
CREATE INDEX "CierreAviso_enviadoAt_idx" ON "CierreAviso"("enviadoAt");

-- AddForeignKey
ALTER TABLE "CierrePeriodo" ADD CONSTRAINT "CierrePeriodo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CierrePeriodo" ADD CONSTRAINT "CierrePeriodo_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PasoCierre" ADD CONSTRAINT "PasoCierre_cierreId_fkey" FOREIGN KEY ("cierreId") REFERENCES "CierrePeriodo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
