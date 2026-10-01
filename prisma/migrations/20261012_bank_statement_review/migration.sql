-- AlterTable
ALTER TABLE "BankTransaction" ADD COLUMN     "bankReferenceId" TEXT,
ADD COLUMN     "operationTime" TEXT;

-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "controls" JSONB,
ADD COLUMN     "declaredAccount" TEXT,
ADD COLUMN     "declaredCurrency" TEXT,
ADD COLUMN     "fileHash" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'INTERIM',
ADD COLUMN     "parsedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "parserVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "periodEnd" TEXT,
ADD COLUMN     "periodStart" TEXT,
ADD COLUMN     "reviewAttestation" JSONB,
ADD COLUMN     "verificationHash" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedByUserId" TEXT,
ADD COLUMN     "verifiedMonth" INTEGER,
ADD COLUMN     "verifiedYear" INTEGER,
ADD COLUMN     "warnings" JSONB;

-- CreateTable
CREATE TABLE "BankStatementRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "pageNumber" INTEGER,
    "parsed" JSONB NOT NULL,
    "movementId" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "candidateIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "decidedAt" TIMESTAMP(3),
    "decidedByUserId" TEXT,

    CONSTRAINT "BankStatementRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankReviewDecision" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "pairKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankReviewDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankDocumentInbox" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "filename" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankDocumentInbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BankStatementRow_movementId_idx" ON "BankStatementRow"("movementId");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementRow_batchId_rowNumber_key" ON "BankStatementRow"("batchId", "rowNumber");

-- CreateIndex
CREATE INDEX "BankReviewDecision_companyId_bankAccountId_idx" ON "BankReviewDecision"("companyId", "bankAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "BankReviewDecision_companyId_pairKey_fingerprint_key" ON "BankReviewDecision"("companyId", "pairKey", "fingerprint");

-- CreateIndex
CREATE INDEX "BankDocumentInbox_companyId_expiresAt_idx" ON "BankDocumentInbox"("companyId", "expiresAt");

-- CreateIndex
CREATE INDEX "ImportBatch_companyId_verifiedYear_verifiedMonth_idx" ON "ImportBatch"("companyId", "verifiedYear", "verifiedMonth");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_bankAccountId_fileHash_key" ON "ImportBatch"("bankAccountId", "fileHash");

-- AddForeignKey
ALTER TABLE "BankStatementRow" ADD CONSTRAINT "BankStatementRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementRow" ADD CONSTRAINT "BankStatementRow_movementId_fkey" FOREIGN KEY ("movementId") REFERENCES "BankTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankReviewDecision" ADD CONSTRAINT "BankReviewDecision_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankDocumentInbox" ADD CONSTRAINT "BankDocumentInbox_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

