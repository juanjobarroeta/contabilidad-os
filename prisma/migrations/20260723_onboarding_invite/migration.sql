-- Invitaciones de onboarding + tier por defecto del despacho — aditivo.
ALTER TABLE "Despacho" ADD COLUMN "defaultTier" "CompanyPlan";

CREATE TABLE "OnboardingInvite" (
    "id" TEXT NOT NULL,
    "createdByEmail" TEXT NOT NULL,
    "despachoName" TEXT NOT NULL,
    "ownerNombre" TEXT,
    "tierEmpresas" "CompanyPlan" NOT NULL DEFAULT 'AUTOMATIZADO',
    "sinCargo" BOOLEAN NOT NULL DEFAULT true,
    "trialDays" INTEGER NOT NULL DEFAULT 15,
    "tokenHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedByEmail" TEXT,
    "acceptedDespachoId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OnboardingInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OnboardingInvite_tokenHash_key" ON "OnboardingInvite"("tokenHash");
CREATE INDEX "OnboardingInvite_status_idx" ON "OnboardingInvite"("status");
