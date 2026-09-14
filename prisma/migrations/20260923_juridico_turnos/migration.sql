-- Turnos del copiloto jurídico persistidos: eventos por lotes + checkpoint por
-- ronda, para continuar un turno en otro contenedor tras un redespliegue.
CREATE TABLE "JuridicoTurno" (
    "id" TEXT NOT NULL,
    "conversacionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'en_curso',
    "instancia" TEXT NOT NULL,
    "latido" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "eventos" JSONB NOT NULL DEFAULT '[]',
    "checkpoint" JSONB,
    "mensajeUsuarioId" TEXT,
    "pregunta" TEXT NOT NULL DEFAULT '',
    "convCreada" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "terminadoAt" TIMESTAMP(3),

    CONSTRAINT "JuridicoTurno_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "JuridicoTurno_conversacionId_createdAt_idx" ON "JuridicoTurno"("conversacionId", "createdAt");
CREATE INDEX "JuridicoTurno_estado_latido_idx" ON "JuridicoTurno"("estado", "latido");
