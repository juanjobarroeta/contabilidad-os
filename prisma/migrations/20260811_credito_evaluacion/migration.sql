-- Portal de crédito del operador: snapshots inmutables de evaluación.
CREATE TABLE "CreditoEvaluacion" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdByUserId" TEXT,
  "score" INTEGER NOT NULL,
  "banda" TEXT NOT NULL,
  "limiteSugerido" DOUBLE PRECISION NOT NULL,
  "provisional" BOOLEAN NOT NULL DEFAULT false,
  "detalle" JSONB NOT NULL,
  "cobertura" JSONB NOT NULL,
  "decision" TEXT,
  "notas" TEXT,
  CONSTRAINT "CreditoEvaluacion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CreditoEvaluacion_companyId_createdAt_idx" ON "CreditoEvaluacion"("companyId", "createdAt");

ALTER TABLE "CreditoEvaluacion" ADD CONSTRAINT "CreditoEvaluacion_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
