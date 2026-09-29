-- AlterTable
ALTER TABLE "CompanyMember" ADD COLUMN     "hospitalPermisos" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "HospMedico" ADD COLUMN     "credencialEvidencia" TEXT,
ADD COLUMN     "credencialVerificadaAt" TIMESTAMP(3),
ADD COLUMN     "credencialVerificadaPor" TEXT,
ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "HospLote" ADD COLUMN     "bloqueado" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bloqueoMotivo" TEXT;

-- CreateTable
CREATE TABLE "HospAplicacionSolicitud" (
    "companyId" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "cargoId" TEXT NOT NULL,
    "movimientoId" TEXT NOT NULL,
    "notaId" TEXT NOT NULL,
    "loteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospAplicacionSolicitud_pkey" PRIMARY KEY ("companyId","clave")
);

-- CreateTable
CREATE TABLE "HospControlEvento" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "referencia" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "datos" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospControlEvento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HospControlEvento_companyId_tipo_createdAt_idx" ON "HospControlEvento"("companyId", "tipo", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "HospMedico_companyId_userId_key" ON "HospMedico"("companyId", "userId");

-- Control history is append-only, including when accessed outside route handlers.
CREATE OR REPLACE FUNCTION hospital_control_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Hospital control history is append-only; record a new event instead';
END;
$$;
CREATE TRIGGER hospital_control_immutable BEFORE UPDATE OR DELETE ON "HospControlEvento"
FOR EACH ROW EXECUTE FUNCTION hospital_control_immutable();
