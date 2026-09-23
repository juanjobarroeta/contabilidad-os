-- La agenda del SAT: cuándo buscar cada entregable (acuse mensual, balanza de
-- CE, opinión 32-D/CSF) por empresa y periodo. Tabla nueva, sin tocar datos.
CREATE TABLE IF NOT EXISTS "AgendaSat" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "entregable" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "vence" DATE NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "proximaRevision" TIMESTAMP(3),
    "ultimaRevision" TIMESTAMP(3),
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "errores" INTEGER NOT NULL DEFAULT 0,
    "ultimoResultado" TEXT,
    "motivo" TEXT,
    "encontradoAt" TIMESTAMP(3),
    "notaPendienteId" TEXT,

    CONSTRAINT "AgendaSat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AgendaSat_companyId_entregable_periodo_key" ON "AgendaSat"("companyId", "entregable", "periodo");
CREATE INDEX IF NOT EXISTS "AgendaSat_estado_proximaRevision_idx" ON "AgendaSat"("estado", "proximaRevision");

ALTER TABLE "AgendaSat" ADD CONSTRAINT "AgendaSat_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
