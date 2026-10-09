-- Imagenología (consentimiento, cuestionario de seguridad, registro del
-- procedimiento), técnico radiólogo como firmante y referencia del episodio.
ALTER TYPE "HospDocumentoTipo" ADD VALUE 'CONSENTIMIENTO_PROCEDIMIENTO_IMAGEN';
ALTER TYPE "HospDocumentoTipo" ADD VALUE 'CUESTIONARIO_SEGURIDAD_IMAGEN';
ALTER TYPE "HospDocumentoTipo" ADD VALUE 'REGISTRO_PROCEDIMIENTO_IMAGEN';
ALTER TYPE "HospFirmanteRol" ADD VALUE 'TECNICO';

ALTER TABLE "HospEpisodio" ADD COLUMN "medicoReferencia" TEXT,
ADD COLUMN "unidadReferencia" TEXT;
