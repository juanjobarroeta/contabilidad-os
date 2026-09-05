-- CreateEnum
CREATE TYPE "HospMotivoEgreso" AS ENUM ('CURACION', 'MEJORIA', 'TRASLADO', 'DEFUNCION', 'VOLUNTARIA', 'FUGA', 'OTRO');

-- CreateEnum
CREATE TYPE "HospIvaContexto" AS ENUM ('SUMINISTRO_HOSPITALARIO', 'VENTA_DIRECTA');

-- CreateEnum
CREATE TYPE "HospGrupoControl" AS ENUM ('I', 'II', 'III', 'IV', 'V', 'VI');

-- CreateEnum
CREATE TYPE "HospAccesoAccion" AS ENUM ('LECTURA_EXPEDIENTE', 'LECTURA_CUENTA', 'LECTURA_FICHA', 'EXPORTACION', 'IMPRESION');

-- CreateEnum
CREATE TYPE "HospCatalogoTipo" AS ENUM ('CIE10', 'CIE9MC');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "HospDocumentoTipo" ADD VALUE 'CONSENTIMIENTO_TRANSFUSION';
ALTER TYPE "HospDocumentoTipo" ADD VALUE 'CONSENTIMIENTO_HOSPITALIZACION';
ALTER TYPE "HospDocumentoTipo" ADD VALUE 'REGISTRO_ANESTESICO';
ALTER TYPE "HospDocumentoTipo" ADD VALUE 'HOJA_EGRESO';
ALTER TYPE "HospDocumentoTipo" ADD VALUE 'AVISO_PRIVACIDAD';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "HospNotaTipo" ADD VALUE 'HISTORIA_CLINICA';
ALTER TYPE "HospNotaTipo" ADD VALUE 'PREANESTESICA';
ALTER TYPE "HospNotaTipo" ADD VALUE 'POSTANESTESICA';
ALTER TYPE "HospNotaTipo" ADD VALUE 'HOJA_URGENCIAS';
ALTER TYPE "HospNotaTipo" ADD VALUE 'REFERENCIA';

-- AlterTable
ALTER TABLE "HospCargo" ADD COLUMN     "ivaContexto" "HospIvaContexto";

-- AlterTable
ALTER TABLE "HospConfig" ADD COLUMN     "avisoPrivacidadUrl" TEXT,
ADD COLUMN     "avisoPrivacidadVersion" TEXT,
ADD COLUMN     "clues" TEXT,
ADD COLUMN     "ivaMedicinasHospitalizacion" DECIMAL(18,6) NOT NULL DEFAULT 0.16,
ADD COLUMN     "licenciaSanitaria" TEXT,
ADD COLUMN     "responsableSanitario" TEXT,
ADD COLUMN     "responsableSanitarioCedula" TEXT;

-- AlterTable
ALTER TABLE "HospDocumento" ADD COLUMN     "contenido" JSONB,
ADD COLUMN     "firmadoParentesco" TEXT,
ADD COLUMN     "firmadoPor" TEXT,
ADD COLUMN     "medicoCedula" TEXT,
ADD COLUMN     "medicoNombre" TEXT,
ADD COLUMN     "testigo1" TEXT,
ADD COLUMN     "testigo2" TEXT;

-- AlterTable
ALTER TABLE "HospEpisodio" ADD COLUMN     "aldreteEgreso" INTEGER,
ADD COLUMN     "asa" TEXT,
ADD COLUMN     "diagnosticoEgresoCie10" TEXT,
ADD COLUMN     "diagnosticoIngresoCie10" TEXT,
ADD COLUMN     "limiteAmbulatorioAt" TIMESTAMP(3),
ADD COLUMN     "motivoEgreso" "HospMotivoEgreso",
ADD COLUMN     "procedimientoCie9" TEXT,
ADD COLUMN     "seguimientoAt" TIMESTAMP(3),
ADD COLUMN     "seguimientoNota" TEXT,
ADD COLUMN     "triageAt" TIMESTAMP(3),
ADD COLUMN     "triageNivel" INTEGER;

-- AlterTable
ALTER TABLE "HospInsumo" ADD COLUMN     "grupoControl" "HospGrupoControl",
ADD COLUMN     "registroSanitario" TEXT,
ADD COLUMN     "requiereRefrigeracion" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sustanciaActiva" TEXT;

-- AlterTable
ALTER TABLE "HospMovimientoInsumo" ADD COLUMN     "prescriptorCedula" TEXT,
ADD COLUMN     "prescriptorNombre" TEXT,
ADD COLUMN     "recetaRef" TEXT;

-- AlterTable
ALTER TABLE "HospNota" ADD COLUMN     "autorCedula" TEXT,
ADD COLUMN     "hash" TEXT,
ADD COLUMN     "secciones" JSONB,
ADD COLUMN     "selloAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "HospPaciente" ADD COLUMN     "avisoPrivacidadAceptadoAt" TIMESTAMP(3),
ADD COLUMN     "avisoPrivacidadVersion" TEXT,
ADD COLUMN     "calle" TEXT,
ADD COLUMN     "codigoPostal" TEXT,
ADD COLUMN     "colonia" TEXT,
ADD COLUMN     "curpValidada" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "entidadNacimiento" TEXT,
ADD COLUMN     "estado" TEXT,
ADD COLUMN     "expedienteNumero" TEXT,
ADD COLUMN     "municipio" TEXT,
ADD COLUMN     "nacionalidad" TEXT DEFAULT 'MEX',
ADD COLUMN     "numeroExterior" TEXT,
ADD COLUMN     "numeroInterior" TEXT,
ADD COLUMN     "sinCurp" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sinCurpMotivo" TEXT;

-- CreateTable
CREATE TABLE "HospAcceso" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "episodioId" TEXT,
    "pacienteId" TEXT,
    "userId" TEXT,
    "userEmail" TEXT,
    "accion" "HospAccesoAccion" NOT NULL,
    "detalle" TEXT,
    "ip" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospAcceso_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospCatalogo" (
    "id" TEXT NOT NULL,
    "tipo" "HospCatalogoTipo" NOT NULL,
    "clave" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "nivel" INTEGER NOT NULL,
    "capitulo" TEXT,
    "capituloNombre" TEXT,
    "subtipo" TEXT,
    "sexo" TEXT,
    "edadMin" INTEGER,
    "edadMax" INTEGER,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "version" TEXT,

    CONSTRAINT "HospCatalogo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HospAcceso_companyId_at_idx" ON "HospAcceso"("companyId", "at");

-- CreateIndex
CREATE INDEX "HospAcceso_episodioId_at_idx" ON "HospAcceso"("episodioId", "at");

-- CreateIndex
CREATE INDEX "HospAcceso_pacienteId_at_idx" ON "HospAcceso"("pacienteId", "at");

-- CreateIndex
CREATE INDEX "HospCatalogo_tipo_codigo_idx" ON "HospCatalogo"("tipo", "codigo");

-- CreateIndex
CREATE UNIQUE INDEX "HospCatalogo_tipo_clave_key" ON "HospCatalogo"("tipo", "clave");

-- CreateIndex
CREATE UNIQUE INDEX "HospPaciente_companyId_expedienteNumero_key" ON "HospPaciente"("companyId", "expedienteNumero");

-- AddForeignKey
ALTER TABLE "HospAcceso" ADD CONSTRAINT "HospAcceso_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

