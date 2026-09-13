-- Asunto (caso) y partes: la fuente de verdad de lo que el copiloto redacta.
CREATE TABLE "JuridicoAsunto" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "materia" TEXT,
    "via" TEXT,
    "autoridad" TEXT,
    "expediente" TEXT,
    "entidad" TEXT,
    "cliente" TEXT,
    "objetivo" TEXT,
    "decisiones" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JuridicoAsunto_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JuridicoAsunto_userId_updatedAt_idx" ON "JuridicoAsunto"("userId", "updatedAt");
ALTER TABLE "JuridicoAsunto" ADD CONSTRAINT "JuridicoAsunto_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "JuridicoParte" (
    "id" TEXT NOT NULL,
    "asuntoId" TEXT NOT NULL,
    "rol" TEXT NOT NULL,
    "tipoPersona" TEXT NOT NULL DEFAULT 'fisica',
    "nombre" TEXT NOT NULL,
    "rfc" TEXT,
    "curp" TEXT,
    "domicilio" TEXT,
    "representante" TEXT,
    "email" TEXT,
    "telefono" TEXT,
    "notas" TEXT,
    "fuente" TEXT NOT NULL DEFAULT 'chat',
    "documentoId" TEXT,
    "verificado" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "JuridicoParte_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JuridicoParte_asuntoId_idx" ON "JuridicoParte"("asuntoId");
ALTER TABLE "JuridicoParte" ADD CONSTRAINT "JuridicoParte_asuntoId_fkey" FOREIGN KEY ("asuntoId") REFERENCES "JuridicoAsunto"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JuridicoConversacion" ADD COLUMN "asuntoId" TEXT;
CREATE INDEX "JuridicoConversacion_asuntoId_idx" ON "JuridicoConversacion"("asuntoId");
ALTER TABLE "JuridicoConversacion" ADD CONSTRAINT "JuridicoConversacion_asuntoId_fkey" FOREIGN KEY ("asuntoId") REFERENCES "JuridicoAsunto"("id") ON DELETE SET NULL ON UPDATE CASCADE;
