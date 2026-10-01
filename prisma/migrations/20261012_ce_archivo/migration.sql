-- Contabilidad Electrónica: se guarda TODO XML bajado del SAT (balanzas,
-- catálogo, pólizas, auxiliares). Antes el catálogo se bajaba y se descartaba.
CREATE TABLE "CeArchivo" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "anio" INTEGER NOT NULL,
    "mes" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "xml" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "importadoEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CeArchivo_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CeArchivo_companyId_nombre_key" ON "CeArchivo"("companyId", "nombre");
CREATE INDEX "CeArchivo_companyId_tipo_anio_mes_idx" ON "CeArchivo"("companyId", "tipo", "anio", "mes");

ALTER TABLE "CeArchivo" ADD CONSTRAINT "CeArchivo_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
