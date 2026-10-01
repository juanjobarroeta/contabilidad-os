-- CreateTable
CREATE TABLE "ContaBotSession" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerSessionId" TEXT,
    "model" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'idle',
    "activeConversationId" TEXT,
    "activeCompanyId" TEXT,
    "requestId" TEXT,
    "input" TEXT,
    "instructions" TEXT,
    "context" JSONB,
    "providerTurnId" TEXT,
    "previousTurnId" TEXT,
    "assistantMessageId" TEXT,
    "userMessageId" TEXT,
    "turnStartedAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContaBotSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContaBotToolCall" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'running',
    "success" BOOLEAN,
    "result" TEXT,
    "card" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ContaBotToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContaBotSession_providerSessionId_key" ON "ContaBotSession"("providerSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ContaBotSession_activeConversationId_key" ON "ContaBotSession"("activeConversationId");

-- CreateIndex
CREATE UNIQUE INDEX "ContaBotSession_activeCompanyId_key" ON "ContaBotSession"("activeCompanyId");

-- CreateIndex
CREATE INDEX "ContaBotSession_state_lastSyncedAt_idx" ON "ContaBotSession"("state", "lastSyncedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContaBotSession_conversationId_userId_key" ON "ContaBotSession"("conversationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ContaBotToolCall_sessionId_turnId_callId_key" ON "ContaBotToolCall"("sessionId", "turnId", "callId");

-- AddForeignKey
ALTER TABLE "ContaBotSession" ADD CONSTRAINT "ContaBotSession_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContaBotToolCall" ADD CONSTRAINT "ContaBotToolCall_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ContaBotSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
