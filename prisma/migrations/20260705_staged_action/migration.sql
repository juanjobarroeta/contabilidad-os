-- CreateEnum
CREATE TYPE "StagedActionStatus" AS ENUM ('PENDING', 'EXECUTING', 'DONE', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "StagedAction" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "whatsappConversationId" TEXT,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "StagedActionStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "confirmedByUserId" TEXT,
    "resultUuid" TEXT,
    "error" TEXT,

    CONSTRAINT "StagedAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StagedAction_tokenHash_key" ON "StagedAction"("tokenHash");

-- CreateIndex
CREATE INDEX "StagedAction_companyId_idx" ON "StagedAction"("companyId");

-- CreateIndex
CREATE INDEX "StagedAction_createdByUserId_idx" ON "StagedAction"("createdByUserId");

-- AddForeignKey
ALTER TABLE "StagedAction" ADD CONSTRAINT "StagedAction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

