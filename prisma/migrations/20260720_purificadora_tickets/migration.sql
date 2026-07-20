-- CreateEnum
CREATE TYPE "PurifTicketEstado" AS ENUM ('REGISTRADO', 'INTEGRADO', 'CANCELADO');

-- CreateTable
CREATE TABLE "PurifTicket" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha" TIMESTAMP(3) NOT NULL,
    "formaPago" "PurifFormaPago" NOT NULL,
    "estado" "PurifTicketEstado" NOT NULL DEFAULT 'REGISTRADO',
    "total" DOUBLE PRECISION NOT NULL,
    "garrafones" INTEGER NOT NULL DEFAULT 0,
    "notas" TEXT,
    "corteId" TEXT,

    CONSTRAINT "PurifTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurifTicketItem" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "productoId" TEXT,
    "descripcion" TEXT NOT NULL,
    "cantidad" DOUBLE PRECISION NOT NULL,
    "precioUnitario" DOUBLE PRECISION NOT NULL,
    "importe" DOUBLE PRECISION NOT NULL,
    "garrafones" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PurifTicketItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurifTicket_companyId_fecha_estado_idx" ON "PurifTicket"("companyId", "fecha", "estado");

-- CreateIndex
CREATE INDEX "PurifTicket_corteId_idx" ON "PurifTicket"("corteId");

-- CreateIndex
CREATE INDEX "PurifTicketItem_ticketId_idx" ON "PurifTicketItem"("ticketId");

-- AddForeignKey
ALTER TABLE "PurifTicket" ADD CONSTRAINT "PurifTicket_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifTicket" ADD CONSTRAINT "PurifTicket_corteId_fkey" FOREIGN KEY ("corteId") REFERENCES "PurifCorte"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifTicketItem" ADD CONSTRAINT "PurifTicketItem_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "PurifTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifTicketItem" ADD CONSTRAINT "PurifTicketItem_productoId_fkey" FOREIGN KEY ("productoId") REFERENCES "PurifProducto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

