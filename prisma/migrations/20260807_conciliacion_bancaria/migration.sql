-- Saldos que declara el estado de cuenta importado. El extractor ya los leía
-- para un cuadre de sanidad y luego los tiraba; persistirlos permite proponer
-- el saldo de la conciliación sin capturarlo a mano. Aditivo y nullable.
ALTER TABLE "ImportBatch" ADD COLUMN IF NOT EXISTS "saldoInicial" DOUBLE PRECISION;
ALTER TABLE "ImportBatch" ADD COLUMN IF NOT EXISTS "saldoFinal" DOUBLE PRECISION;

-- Conciliación bancaria mensual: el papel de trabajo que el contador firma.
-- Guarda sólo lo que no se puede derivar (el saldo del estado de cuenta y la
-- firma); el saldo en libros y las partidas se recalculan del ledger.
CREATE TABLE IF NOT EXISTS "ConciliacionBancaria" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "saldoFinalEstado" DOUBLE PRECISION,
    "saldoInicialEstado" DOUBLE PRECISION,
    "saldoManual" BOOLEAN NOT NULL DEFAULT false,
    "conciliadoAt" TIMESTAMP(3),
    "conciliadoByUserId" TEXT,
    "notas" TEXT,

    CONSTRAINT "ConciliacionBancaria_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConciliacionBancaria_bankAccountId_year_month_key"
    ON "ConciliacionBancaria"("bankAccountId", "year", "month");
CREATE INDEX IF NOT EXISTS "ConciliacionBancaria_companyId_year_month_idx"
    ON "ConciliacionBancaria"("companyId", "year", "month");

ALTER TABLE "ConciliacionBancaria"
    ADD CONSTRAINT "ConciliacionBancaria_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConciliacionBancaria"
    ADD CONSTRAINT "ConciliacionBancaria_bankAccountId_fkey"
    FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
