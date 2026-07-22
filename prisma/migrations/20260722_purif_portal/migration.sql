-- CreateTable
CREATE TABLE "PurifPortalAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "PurifPortalAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PurifPortalAccount_customerId_key" ON "PurifPortalAccount"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "PurifPortalAccount_email_key" ON "PurifPortalAccount"("email");

-- CreateIndex
CREATE INDEX "PurifPortalAccount_companyId_idx" ON "PurifPortalAccount"("companyId");

-- AddForeignKey
ALTER TABLE "PurifPortalAccount" ADD CONSTRAINT "PurifPortalAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurifPortalAccount" ADD CONSTRAINT "PurifPortalAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

