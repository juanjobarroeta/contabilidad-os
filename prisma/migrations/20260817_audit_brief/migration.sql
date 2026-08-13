-- Lectura ejecutiva del auditor: los checks producen cientos de hallazgos
-- granulares; el brief los agrupa por causa raíz y los prioriza. Uno por
-- empresa (el más reciente).
CREATE TABLE "AuditBrief" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "resumen" TEXT NOT NULL,
  "grupos" JSONB NOT NULL,
  "hallazgosAbiertos" INTEGER NOT NULL,
  "generadoAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuditBrief_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuditBrief_companyId_key" ON "AuditBrief"("companyId");
