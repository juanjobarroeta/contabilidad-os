-- CreateTable
CREATE TABLE "WhatsappLinkCode" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "WhatsappLinkCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsappLinkCode_code_idx" ON "WhatsappLinkCode"("code");

-- CreateIndex
CREATE INDEX "WhatsappLinkCode_userId_idx" ON "WhatsappLinkCode"("userId");

-- AddForeignKey
ALTER TABLE "WhatsappLinkCode" ADD CONSTRAINT "WhatsappLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

