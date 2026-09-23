-- Prórrogas del SAT aprendidas de los acuses (agenda del SAT). Tabla nueva.
CREATE TABLE IF NOT EXISTS "ProrrogaSat" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "entregable" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "vence" DATE NOT NULL,
    "fuente" TEXT NOT NULL,

    CONSTRAINT "ProrrogaSat_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ProrrogaSat_entregable_periodo_key" ON "ProrrogaSat"("entregable", "periodo");
