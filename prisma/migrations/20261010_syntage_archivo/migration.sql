-- Cierre de Syntage (oct-2026): archivo de todo lo que había en la cuenta
-- antes de borrar las entidades. Aditiva.
CREATE TABLE IF NOT EXISTS "SyntageArchivo" (
  "id" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rfc" TEXT NOT NULL,
  "companyId" TEXT,
  "entityId" TEXT NOT NULL,
  "tipo" TEXT NOT NULL,
  "ref" TEXT NOT NULL,
  "nombre" TEXT,
  "contentType" TEXT,
  "bytes" BYTEA,
  "datos" JSONB,
  CONSTRAINT "SyntageArchivo_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SyntageArchivo_rfc_tipo_ref_key" ON "SyntageArchivo"("rfc", "tipo", "ref");
CREATE INDEX IF NOT EXISTS "SyntageArchivo_rfc_tipo_idx" ON "SyntageArchivo"("rfc", "tipo");
