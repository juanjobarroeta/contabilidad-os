-- Reglas de clasificación aprendidas: lo que el distribuidor confirmó una vez
-- sobre el residuo que el catálogo del SAT no distingue.
CREATE TABLE "ReglaClasificacion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ambito" TEXT NOT NULL,
    "clavePrefijo" TEXT,
    "patron" TEXT,
    "destino" TEXT NOT NULL,
    "etiqueta" TEXT NOT NULL,
    "origen" TEXT NOT NULL DEFAULT 'MANUAL',
    "confianza" DOUBLE PRECISION,
    "razon" TEXT,
    "activa" BOOLEAN NOT NULL DEFAULT false,
    "confirmadaPor" TEXT,
    "confirmadaAt" TIMESTAMP(3),

    CONSTRAINT "ReglaClasificacion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReglaClasificacion_companyId_ambito_activa_idx" ON "ReglaClasificacion"("companyId", "ambito", "activa");

ALTER TABLE "ReglaClasificacion" ADD CONSTRAINT "ReglaClasificacion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
