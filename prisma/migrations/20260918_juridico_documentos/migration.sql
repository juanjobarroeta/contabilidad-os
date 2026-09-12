-- Documentos (contratos, demandas) adjuntos a una conversación del copiloto jurídico.
CREATE TABLE "JuridicoDocumento" (
    "id" TEXT NOT NULL,
    "conversacionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "paginas" INTEGER,
    "caracteres" INTEGER NOT NULL,
    "texto" TEXT NOT NULL,
    "secciones" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JuridicoDocumento_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "JuridicoDocumento_conversacionId_idx" ON "JuridicoDocumento"("conversacionId");

ALTER TABLE "JuridicoDocumento" ADD CONSTRAINT "JuridicoDocumento_conversacionId_fkey" FOREIGN KEY ("conversacionId") REFERENCES "JuridicoConversacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
