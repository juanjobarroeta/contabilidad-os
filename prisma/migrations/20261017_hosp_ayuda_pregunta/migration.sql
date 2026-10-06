-- Mascota de ayuda del satélite Hospital: preguntas, respuestas y valoración.
CREATE TABLE "HospAyudaPregunta" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT,
    "userNombre" TEXT,
    "pagina" TEXT,
    "pregunta" TEXT NOT NULL,
    "respuesta" TEXT NOT NULL,
    "paginasSugeridas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sinRespuesta" BOOLEAN NOT NULL DEFAULT false,
    "modelo" TEXT,
    "util" BOOLEAN,
    "comentario" TEXT,
    "valoradaAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HospAyudaPregunta_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "HospAyudaPregunta_companyId_createdAt_idx" ON "HospAyudaPregunta"("companyId", "createdAt");

ALTER TABLE "HospAyudaPregunta" ADD CONSTRAINT "HospAyudaPregunta_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
