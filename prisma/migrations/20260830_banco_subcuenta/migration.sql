-- Subcuenta contable por cuenta bancaria (CE confiable, Ola B).
ALTER TABLE "BankAccount" ADD COLUMN "chartAccountId" TEXT;
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_chartAccountId_fkey"
  FOREIGN KEY ("chartAccountId") REFERENCES "ChartAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
