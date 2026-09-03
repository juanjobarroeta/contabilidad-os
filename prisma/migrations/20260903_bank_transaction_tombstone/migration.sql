-- CreateTable
CREATE TABLE "BankTransactionTombstone" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "txId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "monto" DECIMAL(18,6) NOT NULL,
    "descripcion" TEXT NOT NULL,
    "referencia" TEXT,
    "motivo" TEXT,
    "userId" TEXT,

    CONSTRAINT "BankTransactionTombstone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankTransactionTombstone_bankAccountId_fecha_idx" ON "BankTransactionTombstone"("bankAccountId", "fecha");

-- AddForeignKey
ALTER TABLE "BankTransactionTombstone" ADD CONSTRAINT "BankTransactionTombstone_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransactionTombstone" ADD CONSTRAINT "BankTransactionTombstone_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
