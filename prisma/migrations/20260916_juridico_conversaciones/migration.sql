-- Conversaciones del copiloto jurídico (docs/MOTOR-JURIDICO.md §6).
CREATE TABLE "JuridicoConversacion" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "titulo" TEXT NOT NULL DEFAULT 'Nueva conversación',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "archivedAt" TIMESTAMP(3),
  CONSTRAINT "JuridicoConversacion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JuridicoConversacion_userId_updatedAt_idx" ON "JuridicoConversacion"("userId", "updatedAt");
ALTER TABLE "JuridicoConversacion" ADD CONSTRAINT "JuridicoConversacion_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "JuridicoMensaje" (
  "id" TEXT NOT NULL,
  "conversacionId" TEXT NOT NULL,
  "rol" TEXT NOT NULL,
  "contenido" TEXT NOT NULL,
  "meta" JSONB,
  "feedback" TEXT,
  "correccion" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "JuridicoMensaje_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "JuridicoMensaje_conversacionId_createdAt_idx" ON "JuridicoMensaje"("conversacionId", "createdAt");
ALTER TABLE "JuridicoMensaje" ADD CONSTRAINT "JuridicoMensaje_conversacionId_fkey" FOREIGN KEY ("conversacionId") REFERENCES "JuridicoConversacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
