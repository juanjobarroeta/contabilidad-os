-- CreateEnum
CREATE TYPE "HospCurpOrigen" AS ENUM ('CAPTURA', 'DOCUMENTO', 'RENAPO', 'CALCULADA');

-- CreateEnum
CREATE TYPE "HospRfcFuente" AS ENUM ('CAPTURA', 'CSF', 'CALCULADO');

-- CreateEnum
CREATE TYPE "HospIdentificacionTipo" AS ENUM ('INE', 'PASAPORTE', 'LICENCIA', 'CEDULA_PROFESIONAL', 'CARTILLA', 'CSF', 'OTRO');

-- CreateEnum
CREATE TYPE "HospFirmanteRol" AS ENUM ('PACIENTE', 'REPRESENTANTE', 'TESTIGO1', 'TESTIGO2', 'MEDICO', 'RESPONSABLE_PAGO', 'HOSPITAL');

-- CreateEnum
CREATE TYPE "HospFirmaMetodo" AS ENUM ('AUTOGRAFA_DIGITAL', 'OTP', 'PSC');

-- CreateEnum
CREATE TYPE "HospSaehEstado" AS ENUM ('PENDIENTE', 'COMPLETO', 'EXPORTADO');

-- AlterEnum
ALTER TYPE "HospAccesoAccion" ADD VALUE 'CONSULTA_RENAPO';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "HospCatalogoTipo" ADD VALUE 'SERVICIO';
ALTER TYPE "HospCatalogoTipo" ADD VALUE 'AFILIACION';
ALTER TYPE "HospCatalogoTipo" ADD VALUE 'PAIS';
ALTER TYPE "HospCatalogoTipo" ADD VALUE 'ENTIDAD';
ALTER TYPE "HospCatalogoTipo" ADD VALUE 'MUNICIPIO';
ALTER TYPE "HospCatalogoTipo" ADD VALUE 'LOCALIDAD';
ALTER TYPE "HospCatalogoTipo" ADD VALUE 'LENGUA';
ALTER TYPE "HospCatalogoTipo" ADD VALUE 'CLUES';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "HospDocumentoTipo" ADD VALUE 'CONTRATO_SERVICIOS';
ALTER TYPE "HospDocumentoTipo" ADD VALUE 'COMPROMISO_PAGO';
ALTER TYPE "HospDocumentoTipo" ADD VALUE 'CESION_DERECHOS';
ALTER TYPE "HospDocumentoTipo" ADD VALUE 'CONSENTIMIENTO_DATOS';
ALTER TYPE "HospDocumentoTipo" ADD VALUE 'CONSTANCIA_CURP';
ALTER TYPE "HospDocumentoTipo" ADD VALUE 'RESUMEN_CLINICO';

-- AlterTable
ALTER TABLE "HospCatalogo" ADD COLUMN     "datos" JSONB,
ADD COLUMN     "padre" TEXT;

-- AlterTable
ALTER TABLE "HospConfig" ADD COLUMN     "oidRaiz" TEXT,
ADD COLUMN     "plantillasDocumentos" JSONB,
ADD COLUMN     "saehInstitucion" TEXT DEFAULT 'SMP';

-- AlterTable
ALTER TABLE "HospDocumento" ADD COLUMN     "firmasRequeridas" JSONB,
ADD COLUMN     "hashContenido" TEXT,
ADD COLUMN     "pacienteId" TEXT,
ADD COLUMN     "plantillaVersion" TEXT,
ADD COLUMN     "textoFirmado" TEXT,
ALTER COLUMN "episodioId" DROP NOT NULL;

-- Los documentos existentes son todos de un episodio: heredan su paciente.
UPDATE "HospDocumento" d SET "pacienteId" = e."pacienteId" FROM "HospEpisodio" e WHERE d."episodioId" = e.id AND d."pacienteId" IS NULL;
ALTER TABLE "HospDocumento" ALTER COLUMN "pacienteId" SET NOT NULL;

-- AlterTable
ALTER TABLE "HospMedico" ADD COLUMN     "apellidoMaterno" TEXT,
ADD COLUMN     "apellidoPaterno" TEXT,
ADD COLUMN     "curp" TEXT,
ADD COLUMN     "nombres" TEXT,
ADD COLUMN     "paisNacimientoClave" TEXT DEFAULT '142';

-- AlterTable
ALTER TABLE "HospPaciente" ADD COLUMN     "curpEstatus" TEXT,
ADD COLUMN     "curpOrigen" "HospCurpOrigen",
ADD COLUMN     "curpProbable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "curpVerificadaAt" TIMESTAMP(3),
ADD COLUMN     "curpVerificadaFuente" TEXT,
ADD COLUMN     "curpVerificadaRef" TEXT,
ADD COLUMN     "derechohabienciaClave" TEXT,
ADD COLUMN     "entidadNacimientoClave" TEXT,
ADD COLUMN     "entidadResidenciaClave" TEXT,
ADD COLUMN     "esMigranteRetornado" BOOLEAN,
ADD COLUMN     "estadoConyugal" INTEGER,
ADD COLUMN     "genero" INTEGER,
ADD COLUMN     "hablaLenguaIndigena" BOOLEAN,
ADD COLUMN     "identificacionNumero" TEXT,
ADD COLUMN     "identificacionTipo" "HospIdentificacionTipo",
ADD COLUMN     "identificacionVigencia" TIMESTAMP(3),
ADD COLUMN     "lenguaIndigenaClave" TEXT,
ADD COLUMN     "localidadResidenciaClave" TEXT,
ADD COLUMN     "municipioResidenciaClave" TEXT,
ADD COLUMN     "otraLocalidad" TEXT,
ADD COLUMN     "paisNacimientoClave" TEXT,
ADD COLUMN     "paisResidenciaClave" TEXT,
ADD COLUMN     "renapoCoincide" BOOLEAN,
ADD COLUMN     "renapoNombres" TEXT,
ADD COLUMN     "renapoPrimerApellido" TEXT,
ADD COLUMN     "renapoSegundoApellido" TEXT,
ADD COLUMN     "rfc" TEXT,
ADD COLUMN     "rfcFuente" "HospRfcFuente",
ADD COLUMN     "seConsideraAfromexicano" BOOLEAN,
ADD COLUMN     "seConsideraIndigena" BOOLEAN,
ADD COLUMN     "seIdentificaLgbti" INTEGER;

-- CreateTable
CREATE TABLE "HospFirma" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "rol" "HospFirmanteRol" NOT NULL,
    "nombre" TEXT NOT NULL,
    "identificacion" TEXT,
    "parentesco" TEXT,
    "metodo" "HospFirmaMetodo" NOT NULL DEFAULT 'AUTOGRAFA_DIGITAL',
    "imagen" TEXT,
    "hashDocumento" TEXT NOT NULL,
    "hashFirma" TEXT NOT NULL,
    "otpVerificado" BOOLEAN NOT NULL DEFAULT false,
    "otpDestino" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "geolocalizacion" TEXT,
    "userId" TEXT,
    "userEmail" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospFirma_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HospEgresoSaeh" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "episodioId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "folioSaeh" TEXT,
    "estado" "HospSaehEstado" NOT NULL DEFAULT 'PENDIENTE',
    "validacion" JSONB,
    "exportadoAt" TIMESTAMP(3),
    "exportadoArchivo" TEXT,
    "nacioHospital" INTEGER,
    "peso" DECIMAL(6,3),
    "talla" INTEGER,
    "gratuidad" INTEGER,
    "tipoServicioIngreso" INTEGER,
    "claveServicioIngreso" TEXT,
    "serviciosAdicionales" TEXT[],
    "claveServicioEgreso" TEXT,
    "terapiaIntensivaDias" INTEGER,
    "terapiaIntensivaHoras" INTEGER,
    "terapiaIntermediaDias" INTEGER,
    "terapiaIntermediaHoras" INTEGER,
    "procedencia" INTEGER,
    "especifiqueProcedencia" TEXT,
    "cluesProcedencia" TEXT,
    "cluesReferido" TEXT,
    "mujerFertil" INTEGER,
    "descripcionAfeccionPrincipal" TEXT,
    "codigoAfeccionPrincipal" TEXT,
    "comorbilidades" JSONB,
    "tipoAtencion" INTEGER,
    "afeccionReseleccionada" TEXT,
    "causaExterna" TEXT,
    "codigoCausaExterna" TEXT,
    "morfologia" TEXT,
    "infeccionIntrahospitalaria" INTEGER,
    "procedimientos" JSONB,
    "folioLesion" TEXT,
    "ministerioPublico" INTEGER,
    "folioCertificadoDefuncion" TEXT,
    "gestas" INTEGER,
    "partos" INTEGER,
    "abortos" INTEGER,
    "cesareas" INTEGER,
    "extraccionExpulsion" INTEGER,
    "edadGestacional" INTEGER,
    "tipoAtencionObstetrica" INTEGER,
    "tipoParto" INTEGER,
    "tipoProcAborto" INTEGER,
    "productoEmbarazo" INTEGER,
    "totalProductos" INTEGER,
    "planificacionFamiliar" INTEGER,
    "otroMetodo" TEXT,
    "productos" JSONB,
    "tipoUnidadPsiq" INTEGER,
    "tipoServicioPsiq" INTEGER,
    "medicoResponsableId" TEXT,

    CONSTRAINT "HospEgresoSaeh_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HospFirma_documentoId_idx" ON "HospFirma"("documentoId");

-- CreateIndex
CREATE INDEX "HospFirma_companyId_at_idx" ON "HospFirma"("companyId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "HospEgresoSaeh_episodioId_key" ON "HospEgresoSaeh"("episodioId");

-- CreateIndex
CREATE INDEX "HospEgresoSaeh_companyId_estado_idx" ON "HospEgresoSaeh"("companyId", "estado");

-- CreateIndex
CREATE UNIQUE INDEX "HospEgresoSaeh_companyId_folioSaeh_key" ON "HospEgresoSaeh"("companyId", "folioSaeh");

-- CreateIndex
CREATE INDEX "HospCatalogo_tipo_padre_idx" ON "HospCatalogo"("tipo", "padre");

-- CreateIndex
CREATE INDEX "HospDocumento_pacienteId_idx" ON "HospDocumento"("pacienteId");

-- AddForeignKey
ALTER TABLE "HospDocumento" ADD CONSTRAINT "HospDocumento_pacienteId_fkey" FOREIGN KEY ("pacienteId") REFERENCES "HospPaciente"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospFirma" ADD CONSTRAINT "HospFirma_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "HospDocumento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospFirma" ADD CONSTRAINT "HospFirma_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospEgresoSaeh" ADD CONSTRAINT "HospEgresoSaeh_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospEgresoSaeh" ADD CONSTRAINT "HospEgresoSaeh_episodioId_fkey" FOREIGN KEY ("episodioId") REFERENCES "HospEpisodio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospEgresoSaeh" ADD CONSTRAINT "HospEgresoSaeh_medicoResponsableId_fkey" FOREIGN KEY ("medicoResponsableId") REFERENCES "HospMedico"("id") ON DELETE SET NULL ON UPDATE CASCADE;

