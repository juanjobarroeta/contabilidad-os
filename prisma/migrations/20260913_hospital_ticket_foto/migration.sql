-- AlterTable
ALTER TABLE "HospTicket" ADD COLUMN     "recursoId" TEXT;

-- CreateTable
CREATE TABLE "HospTicketFoto" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mime" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "archivo" BYTEA NOT NULL,
    "nota" TEXT,
    "subidoPorUserId" TEXT,

    CONSTRAINT "HospTicketFoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HospTicketFoto_ticketId_idx" ON "HospTicketFoto"("ticketId");

-- AddForeignKey
ALTER TABLE "HospTicketFoto" ADD CONSTRAINT "HospTicketFoto_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospTicketFoto" ADD CONSTRAINT "HospTicketFoto_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "HospTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HospTicket" ADD CONSTRAINT "HospTicket_recursoId_fkey" FOREIGN KEY ("recursoId") REFERENCES "HospRecurso"("id") ON DELETE SET NULL ON UPDATE CASCADE;

