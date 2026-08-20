-- Intake & prioritization (docs/INTAKE.md). Fully additive.
-- pgvector ya está instalado en producción (fiscal knowledge base); el
-- IF NOT EXISTS cubre entornos frescos donde esta migración corre primero.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "IntakeSource" AS ENUM ('WHATSAPP', 'ZOOM', 'MANUAL', 'EMAIL');

-- CreateEnum
CREATE TYPE "IntakeAskKind" AS ENUM ('BUG', 'FEATURE', 'QUESTION', 'NOISE');

-- CreateEnum
CREATE TYPE "IntakeAskStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'MERGED', 'AUTO_APPROVED');

-- CreateTable
CREATE TABLE "RawIntake" (
    "id" TEXT NOT NULL,
    "source" "IntakeSource" NOT NULL,
    "externalId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMP(3),
    "processError" TEXT,

    CONSTRAINT "RawIntake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeContact" (
    "id" TEXT NOT NULL,
    "displayName" TEXT,
    "phoneE164" TEXT,
    "email" TEXT,
    "company" TEXT,
    "stripeCustomerId" TEXT,
    "primaryProduct" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakeContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeTranscript" (
    "id" TEXT NOT NULL,
    "rawIntakeId" TEXT NOT NULL,
    "meetingTopic" TEXT,
    "productHint" TEXT,
    "startedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "participants" JSONB,
    "provider" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'es-MX',
    "segments" JSONB NOT NULL,
    "fullText" TEXT NOT NULL,
    "extractedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakeTranscript_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandidateAsk" (
    "id" TEXT NOT NULL,
    "rawIntakeId" TEXT,
    "transcriptId" TEXT,
    "contactId" TEXT,
    "product" TEXT,
    "kind" "IntakeAskKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "quote" TEXT,
    "quoteTsSec" INTEGER,
    "confidence" DOUBLE PRECISION,
    "dedupeOfId" TEXT,
    "status" "IntakeAskStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "notifiedAt" TIMESTAMP(3),
    "telegramMessageId" TEXT,
    "githubIssueUrl" TEXT,
    "githubNodeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandidateAsk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AskEmbedding" (
    "candidateAskId" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,

    CONSTRAINT "AskEmbedding_pkey" PRIMARY KEY ("candidateAskId")
);

-- CreateTable
CREATE TABLE "IntakeScoreSnapshot" (
    "id" TEXT NOT NULL,
    "weekOf" TIMESTAMP(3) NOT NULL,
    "issueNodeId" TEXT NOT NULL,
    "issueUrl" TEXT,
    "title" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntakeScoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RawIntake_source_externalId_key" ON "RawIntake"("source", "externalId");

-- CreateIndex
CREATE INDEX "RawIntake_source_processedAt_receivedAt_idx" ON "RawIntake"("source", "processedAt", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeContact_phoneE164_key" ON "IntakeContact"("phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeContact_email_key" ON "IntakeContact"("email");

-- CreateIndex
CREATE INDEX "IntakeTranscript_extractedAt_createdAt_idx" ON "IntakeTranscript"("extractedAt", "createdAt");

-- CreateIndex
CREATE INDEX "CandidateAsk_status_createdAt_idx" ON "CandidateAsk"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CandidateAsk_product_kind_idx" ON "CandidateAsk"("product", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeScoreSnapshot_weekOf_issueNodeId_key" ON "IntakeScoreSnapshot"("weekOf", "issueNodeId");

-- CreateIndex
CREATE INDEX "IntakeScoreSnapshot_weekOf_rank_idx" ON "IntakeScoreSnapshot"("weekOf", "rank");

-- AddForeignKey
ALTER TABLE "IntakeTranscript" ADD CONSTRAINT "IntakeTranscript_rawIntakeId_fkey" FOREIGN KEY ("rawIntakeId") REFERENCES "RawIntake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateAsk" ADD CONSTRAINT "CandidateAsk_rawIntakeId_fkey" FOREIGN KEY ("rawIntakeId") REFERENCES "RawIntake"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateAsk" ADD CONSTRAINT "CandidateAsk_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "IntakeTranscript"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateAsk" ADD CONSTRAINT "CandidateAsk_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "IntakeContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CandidateAsk" ADD CONSTRAINT "CandidateAsk_dedupeOfId_fkey" FOREIGN KEY ("dedupeOfId") REFERENCES "CandidateAsk"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AskEmbedding" ADD CONSTRAINT "AskEmbedding_candidateAskId_fkey" FOREIGN KEY ("candidateAskId") REFERENCES "CandidateAsk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
