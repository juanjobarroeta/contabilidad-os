-- Devolución bancaria (pago rebotado): la DEVOLUCIÓN apunta al pago ORIGINAL.
-- Aditiva: columna opcional + unique + FK autorreferente.

-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN "devolucionDeId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_devolucionDeId_key" ON "BankTransaction"("devolucionDeId");

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_devolucionDeId_fkey" FOREIGN KEY ("devolucionDeId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
