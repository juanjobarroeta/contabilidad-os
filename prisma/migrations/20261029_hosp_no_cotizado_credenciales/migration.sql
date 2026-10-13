-- AlterTable
ALTER TABLE "HospMedico" ADD COLUMN     "cedulaEspecialidad" TEXT,
ADD COLUMN     "credencialNotas" TEXT,
ADD COLUMN     "credencialSeguimiento" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "HospCotizacionPartida" ADD COLUMN     "sinCotizar" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "HospMedicoDocumento" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "medicoId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tipo" TEXT NOT NULL,
    "numero" TEXT,
    "emitidoPor" TEXT,
    "vigenciaHasta" TIMESTAMP(3),
    "estado" TEXT NOT NULL DEFAULT 'RECIBIDO',
    "notas" TEXT,
    "verificadoPorUserId" TEXT,
    "verificadoPorNombre" TEXT,
    "verificadoAt" TIMESTAMP(3),
    "nombreArchivo" TEXT,
    "mime" TEXT,
    "bytes" INTEGER,
    "archivo" BYTEA,
    "subidoPorUserId" TEXT,

    CONSTRAINT "HospMedicoDocumento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HospMedicoDocumento_medicoId_idx" ON "HospMedicoDocumento"("medicoId");

-- CreateIndex
CREATE INDEX "HospMedicoDocumento_companyId_vigenciaHasta_idx" ON "HospMedicoDocumento"("companyId", "vigenciaHasta");

-- AddForeignKey
ALTER TABLE "HospMedicoDocumento" ADD CONSTRAINT "HospMedicoDocumento_medicoId_fkey" FOREIGN KEY ("medicoId") REFERENCES "HospMedico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

