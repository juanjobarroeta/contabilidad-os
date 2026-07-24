-- CreateTable
CREATE TABLE "AutoPortalAccount" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "AutoPortalAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutoPortalAccount_customerId_key" ON "AutoPortalAccount"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "AutoPortalAccount_email_key" ON "AutoPortalAccount"("email");

-- CreateIndex
CREATE INDEX "AutoPortalAccount_companyId_idx" ON "AutoPortalAccount"("companyId");

-- AddForeignKey
ALTER TABLE "AutoPortalAccount" ADD CONSTRAINT "AutoPortalAccount_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoPortalAccount" ADD CONSTRAINT "AutoPortalAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

