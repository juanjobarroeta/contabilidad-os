-- Solicitudes al cliente: «necesito esto de ti», como objeto de primera clase.
--
-- El sistema sabía detectar que le faltaba algo y no sabía PEDIRLO. Una
-- solicitud no es una notificación: una notificación se lee y se va, ésta queda
-- ABIERTA hasta que llega lo que se pidió, y mientras tanto se enseña junto al
-- movimiento que la provocó.
--
-- `dedupeKey` con su único por empresa es lo que evita que la corrida diaria
-- abra el mismo pedido cada mañana: el motor re-detecta el mismo hueco todos
-- los días y sin candado el cliente recibiría veinte veces lo mismo hasta
-- dejar de leerlo.

-- CreateTable
CREATE TABLE "Solicitud" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tipo" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "refs" TEXT[],
    "periodo" TEXT,
    "origen" TEXT NOT NULL DEFAULT 'motor',
    "estado" TEXT NOT NULL DEFAULT 'abierta',
    "canalNotif" TEXT[],
    "recibidaAt" TIMESTAMP(3),
    "recibidaRef" TEXT,
    "dedupeKey" TEXT NOT NULL,

    CONSTRAINT "Solicitud_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Solicitud_companyId_estado_createdAt_idx" ON "Solicitud"("companyId", "estado", "createdAt");

-- CreateIndex
CREATE INDEX "Solicitud_companyId_tipo_periodo_idx" ON "Solicitud"("companyId", "tipo", "periodo");

-- CreateIndex
CREATE UNIQUE INDEX "Solicitud_companyId_dedupeKey_key" ON "Solicitud"("companyId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "Solicitud" ADD CONSTRAINT "Solicitud_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

