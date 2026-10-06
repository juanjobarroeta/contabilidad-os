-- Adulto responsable del paciente (firma como REPRESENTANTE).
CREATE TYPE "HospResponsableModo" AS ENUM ('TERCERO', 'PROPIO', 'PENDIENTE');

ALTER TABLE "HospPaciente" ADD COLUMN "responsableModo" "HospResponsableModo";

CREATE TABLE "HospResponsable" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "pacienteId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "apellidoPaterno" TEXT NOT NULL,
    "apellidoMaterno" TEXT,
    "parentesco" TEXT NOT NULL,
    "fechaNacimiento" TIMESTAMP(3),
    "sexo" "HospSexo",
    "curp" TEXT,
    "telefono" TEXT NOT NULL,
    "email" TEXT,
    "domicilio" TEXT,
    "identificacionTipo" "HospIdentificacionTipo",
    "identificacionNumero" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HospResponsable_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HospResponsable_pacienteId_key" ON "HospResponsable"("pacienteId");
CREATE INDEX "HospResponsable_companyId_idx" ON "HospResponsable"("companyId");

ALTER TABLE "HospResponsable" ADD CONSTRAINT "HospResponsable_pacienteId_fkey" FOREIGN KEY ("pacienteId") REFERENCES "HospPaciente"("id") ON DELETE CASCADE ON UPDATE CASCADE;
