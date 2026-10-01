-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "loanAccountId" TEXT;

-- AlterTable
ALTER TABLE "ContaBotSession" ADD COLUMN     "capabilityVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "objectiveRunId" TEXT,
ADD COLUMN     "retiredProviderSessionIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ContaBotMandate" (
    "companyId" TEXT NOT NULL,
    "responsibleUserId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "startPeriod" TEXT NOT NULL,
    "nextPeriod" TEXT NOT NULL,
    "maxRunsPerDay" INTEGER NOT NULL DEFAULT 3,
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "updatedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContaBotMandate_pkey" PRIMARY KEY ("companyId")
);

-- CreateTable
CREATE TABLE "ContaBotObjective" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'cierre',
    "title" TEXT NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "origin" TEXT NOT NULL DEFAULT 'manual',
    "responsibleUserId" TEXT NOT NULL,
    "assignedByUserId" TEXT NOT NULL,
    "conversationId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "pausedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "nextAction" TEXT NOT NULL DEFAULT 'Revisar evidencia del periodo.',
    "dueDate" TEXT,
    "evidence" JSONB,
    "evidenceHash" TEXT,
    "lastRunEvidenceHash" TEXT,
    "requestIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nextCheckAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContaBotObjective_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContaBotObjectiveRun" (
    "id" TEXT NOT NULL,
    "objectiveId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "activeCompanyId" TEXT,
    "userId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "budgetDate" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "sessionId" TEXT,
    "assistantMessageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ContaBotObjectiveRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContaBotMandate_enabled_nextCheckAt_idx" ON "ContaBotMandate"("enabled", "nextCheckAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContaBotObjective_conversationId_key" ON "ContaBotObjective"("conversationId");

-- CreateIndex
CREATE INDEX "ContaBotObjective_nextCheckAt_pausedAt_idx" ON "ContaBotObjective"("nextCheckAt", "pausedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContaBotObjective_companyId_year_month_scope_key" ON "ContaBotObjective"("companyId", "year", "month", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "ContaBotObjectiveRun_activeCompanyId_key" ON "ContaBotObjectiveRun"("activeCompanyId");

-- CreateIndex
CREATE INDEX "ContaBotObjectiveRun_companyId_budgetDate_idx" ON "ContaBotObjectiveRun"("companyId", "budgetDate");

-- CreateIndex
CREATE INDEX "ContaBotObjectiveRun_objectiveId_createdAt_idx" ON "ContaBotObjectiveRun"("objectiveId", "createdAt");

-- CreateIndex
CREATE INDEX "ContaBotObjectiveRun_state_createdAt_idx" ON "ContaBotObjectiveRun"("state", "createdAt");

-- CreateIndex
CREATE INDEX "BankTransaction_loanAccountId_idx" ON "BankTransaction"("loanAccountId");

-- CreateIndex
CREATE INDEX "ContaBotSession_objectiveRunId_idx" ON "ContaBotSession"("objectiveRunId");

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_loanAccountId_fkey" FOREIGN KEY ("loanAccountId") REFERENCES "ChartAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContaBotSession" ADD CONSTRAINT "ContaBotSession_objectiveRunId_fkey" FOREIGN KEY ("objectiveRunId") REFERENCES "ContaBotObjectiveRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContaBotMandate" ADD CONSTRAINT "ContaBotMandate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContaBotObjective" ADD CONSTRAINT "ContaBotObjective_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContaBotObjective" ADD CONSTRAINT "ContaBotObjective_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContaBotObjectiveRun" ADD CONSTRAINT "ContaBotObjectiveRun_objectiveId_fkey" FOREIGN KEY ("objectiveId") REFERENCES "ContaBotObjective"("id") ON DELETE CASCADE ON UPDATE CASCADE;
