-- AlterTable
ALTER TABLE "CostEvent" ADD COLUMN     "userId" TEXT;

-- CreateTable
CREATE TABLE "AiCreditGrant" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "companyId" TEXT NOT NULL,
    "periodo" TEXT NOT NULL,
    "usd" DOUBLE PRECISION NOT NULL,
    "motivo" TEXT NOT NULL,
    "stripeSessionId" TEXT,
    "otorgadoPorUserId" TEXT,
    "nota" TEXT,

    CONSTRAINT "AiCreditGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiCreditGrant_stripeSessionId_key" ON "AiCreditGrant"("stripeSessionId");

-- CreateIndex
CREATE INDEX "AiCreditGrant_companyId_periodo_idx" ON "AiCreditGrant"("companyId", "periodo");

-- CreateIndex
CREATE INDEX "CostEvent_userId_occurredAt_idx" ON "CostEvent"("userId", "occurredAt");

-- AddForeignKey
ALTER TABLE "AiCreditGrant" ADD CONSTRAINT "AiCreditGrant_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

