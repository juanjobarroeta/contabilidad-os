-- CreateEnum
CREATE TYPE "HospPlanEstado" AS ENUM ('PROPUESTO', 'AUTORIZADO', 'EN_CURSO', 'CERRADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "HospFormaPago" AS ENUM ('EFECTIVO', 'TRANSFERENCIA', 'TARJETA', 'CHEQUE');

-- CreateEnum
CREATE TYPE "HospDepositoEstado" AS ENUM ('RECIBIDO', 'APLICADO', 'DEVUELTO', 'CANCELADO');

-- AlterTable
ALTER TABLE "HospCargo" ADD COLUMN     "asientoAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "HospConfig" ADD COLUMN     "contabilidadActiva" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cuentasContables" JSONB,
ADD COLUMN     "iaAsistencia" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sttProveedor" TEXT DEFAULT 'navegador';

-- AlterTable
ALTER TABLE "HospMovimientoInsumo" ADD COLUMN     "asientoAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "HospNota" ADD COLUMN     "asistencia" JSONB;

-- CreateTable
CREATE TABLE "HospProtocolo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "clave" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "tipoEpisodio" "HospEpisodioTipo" NOT NULL DEFAULT 'AMBULATORIO',
    "procedimientoCie9" TEXT,
    "diagnosticoCie10" TEXT,
    "especialidad" TEXT,
    "estanciaNoches" INTEGER NOT NULL DEFAULT 0,
    "quirofanoMinutos" INTEGER,
    "tipoAnestesia" INTEGER,
    "requiereAnestesiologo" BOOLEAN NOT NULL DEFAULT false,
    "honorarioCirujano" DECIMAL(18,2),
    "honorarioAnestesiologo" DECIMAL(18,2),
    "version" INTEGER NOT NULL DEFAULT 1,
    "activo" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "HospProtocolo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospProtocoloPartida" (
    "id" TEXT NOT NULL,
    "protocoloId" TEXT NOT NULL,
    "orden" INTEGER NOT NULL,
    "servicioId" TEXT,
    "categoria" "HospCargoCategoria" NOT NULL,
    "descripcion" TEXT NOT NULL,
    "cantidad" DECIMAL(18,4) NOT NULL,
    "opcional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "HospProtocoloPartida_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospProtocoloInsumo" (
    "id" TEXT NOT NULL,
    "protocoloId" TEXT NOT NULL,
    "insumoId" TEXT NOT NULL,
    "cantidad" DECIMAL(18,4) NOT NULL,
    "opcional" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "HospProtocoloInsumo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospPlanTratamiento" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pacienteId" TEXT NOT NULL,
    "episodioId" TEXT,
    "protocoloId" TEXT,
    "cotizacionId" TEXT,
    "pagadorId" TEXT,
    "medicoId" TEXT,
    "anestesiologoId" TEXT,
    "recursoId" TEXT,
    "nombre" TEXT NOT NULL,
    "procedimientoCie9" TEXT,
    "diagnosticoCie10" TEXT,
    "tipoEpisodio" "HospEpisodioTipo" NOT NULL,
    "estanciaNoches" INTEGER NOT NULL DEFAULT 0,
    "quirofanoMinutos" INTEGER,
    "tipoAnestesia" INTEGER,
    "fechaProgramada" TIMESTAMP(3),
    "estado" "HospPlanEstado" NOT NULL DEFAULT 'PROPUESTO',
    "autorizacionPagador" TEXT,
    "autorizadoAt" TIMESTAMP(3),
    "partidas" JSONB NOT NULL,
    "insumos" JSONB,
    "honorarios" JSONB,
    "subtotal" DECIMAL(18,2) NOT NULL,
    "iva" DECIMAL(18,2) NOT NULL,
    "total" DECIMAL(18,2) NOT NULL,
    "notas" TEXT,
    "creadoPorUserId" TEXT,

    CONSTRAINT "HospPlanTratamiento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospDeposito" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "episodioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha" TIMESTAMP(3) NOT NULL,
    "monto" DECIMAL(18,2) NOT NULL,
    "formaPago" "HospFormaPago" NOT NULL,
    "referencia" TEXT,
    "estado" "HospDepositoEstado" NOT NULL DEFAULT 'RECIBIDO',
    "aplicadoAt" TIMESTAMP(3),
    "devueltoAt" TIMESTAMP(3),
    "asientoAt" TIMESTAMP(3),
    "recibidoPorUserId" TEXT,
    "notas" TEXT,

    CONSTRAINT "HospDeposito_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HospProtocolo_companyId_activo_idx" ON "HospProtocolo"("companyId", "activo");

-- CreateIndex
CREATE UNIQUE INDEX "HospProtocolo_companyId_clave_key" ON "HospProtocolo"("companyId", "clave");

-- CreateIndex
CREATE INDEX "HospProtocoloPartida_protocoloId_idx" ON "HospProtocoloPartida"("protocoloId");

-- CreateIndex
CREATE INDEX "HospProtocoloInsumo_protocoloId_idx" ON "HospProtocoloInsumo"("protocoloId");

-- CreateIndex
CREATE UNIQUE INDEX "HospPlanTratamiento_episodioId_key" ON "HospPlanTratamiento"("episodioId");

-- CreateIndex
CREATE UNIQUE INDEX "HospPlanTratamiento_cotizacionId_key" ON "HospPlanTratamiento"("cotizacionId");

-- CreateIndex
CREATE INDEX "HospPlanTratamiento_companyId_estado_idx" ON "HospPlanTratamiento"("companyId", "estado");

-- CreateIndex
CREATE INDEX "HospPlanTratamiento_pacienteId_idx" ON "HospPlanTratamiento"("pacienteId");

-- CreateIndex
CREATE INDEX "HospDeposito_companyId_fecha_idx" ON "HospDeposito"("companyId", "fecha");

-- CreateIndex
CREATE INDEX "HospDeposito_episodioId_idx" ON "HospDeposito"("episodioId");

-- AddForeignKey
ALTER TABLE "HospProtocolo" ADD CONSTRAINT "HospProtocolo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospProtocoloPartida" ADD CONSTRAINT "HospProtocoloPartida_protocoloId_fkey" FOREIGN KEY ("protocoloId") REFERENCES "HospProtocolo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospProtocoloPartida" ADD CONSTRAINT "HospProtocoloPartida_servicioId_fkey" FOREIGN KEY ("servicioId") REFERENCES "HospServicio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospProtocoloInsumo" ADD CONSTRAINT "HospProtocoloInsumo_protocoloId_fkey" FOREIGN KEY ("protocoloId") REFERENCES "HospProtocolo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospProtocoloInsumo" ADD CONSTRAINT "HospProtocoloInsumo_insumoId_fkey" FOREIGN KEY ("insumoId") REFERENCES "HospInsumo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPlanTratamiento" ADD CONSTRAINT "HospPlanTratamiento_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPlanTratamiento" ADD CONSTRAINT "HospPlanTratamiento_pacienteId_fkey" FOREIGN KEY ("pacienteId") REFERENCES "HospPaciente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPlanTratamiento" ADD CONSTRAINT "HospPlanTratamiento_episodioId_fkey" FOREIGN KEY ("episodioId") REFERENCES "HospEpisodio"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPlanTratamiento" ADD CONSTRAINT "HospPlanTratamiento_protocoloId_fkey" FOREIGN KEY ("protocoloId") REFERENCES "HospProtocolo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPlanTratamiento" ADD CONSTRAINT "HospPlanTratamiento_cotizacionId_fkey" FOREIGN KEY ("cotizacionId") REFERENCES "HospCotizacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPlanTratamiento" ADD CONSTRAINT "HospPlanTratamiento_pagadorId_fkey" FOREIGN KEY ("pagadorId") REFERENCES "HospPagador"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPlanTratamiento" ADD CONSTRAINT "HospPlanTratamiento_medicoId_fkey" FOREIGN KEY ("medicoId") REFERENCES "HospMedico"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPlanTratamiento" ADD CONSTRAINT "HospPlanTratamiento_anestesiologoId_fkey" FOREIGN KEY ("anestesiologoId") REFERENCES "HospMedico"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospPlanTratamiento" ADD CONSTRAINT "HospPlanTratamiento_recursoId_fkey" FOREIGN KEY ("recursoId") REFERENCES "HospRecurso"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospDeposito" ADD CONSTRAINT "HospDeposito_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospDeposito" ADD CONSTRAINT "HospDeposito_episodioId_fkey" FOREIGN KEY ("episodioId") REFERENCES "HospEpisodio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

