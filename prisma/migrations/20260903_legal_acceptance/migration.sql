-- CreateEnum
CREATE TYPE "LegalDocumento" AS ENUM ('TERMINOS', 'AVISO_PRIVACIDAD', 'MANDATO_EFIRMA');

-- CreateTable
CREATE TABLE "LegalAcceptance" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT NOT NULL,
    "email" TEXT,
    "companyId" TEXT,
    "documento" "LegalDocumento" NOT NULL,
    "version" TEXT NOT NULL,
    "contexto" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "LegalAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LegalAcceptance_userId_documento_createdAt_idx" ON "LegalAcceptance"("userId", "documento", "createdAt");

-- CreateIndex
CREATE INDEX "LegalAcceptance_companyId_documento_idx" ON "LegalAcceptance"("companyId", "documento");

