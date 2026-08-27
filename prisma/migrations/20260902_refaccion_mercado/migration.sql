-- CreateTable
CREATE TABLE "RefaccionMercado" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "refaccionId" TEXT NOT NULL,
    "consultadoAt" TIMESTAMP(3) NOT NULL,
    "titulo" TEXT,
    "precioMercado" DOUBLE PRECISION,
    "urlPrincipal" TEXT,
    "resultados" JSONB,

    CONSTRAINT "RefaccionMercado_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RefaccionMercado_refaccionId_key" ON "RefaccionMercado"("refaccionId");

-- CreateIndex
CREATE INDEX "RefaccionMercado_companyId_consultadoAt_idx" ON "RefaccionMercado"("companyId", "consultadoAt");

-- AddForeignKey
ALTER TABLE "RefaccionMercado" ADD CONSTRAINT "RefaccionMercado_refaccionId_fkey" FOREIGN KEY ("refaccionId") REFERENCES "Refaccion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

