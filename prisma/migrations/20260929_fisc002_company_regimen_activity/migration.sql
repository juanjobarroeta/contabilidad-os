-- Preserve regime history while making the current CSF set explicit.
ALTER TABLE "CompanyRegimen"
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "endedAt" TIMESTAMP(3);

-- The temporary default backfills existing rows; @updatedAt is maintained by
-- Prisma and has no database default in the target schema.
ALTER TABLE "CompanyRegimen"
  ALTER COLUMN "updatedAt" DROP DEFAULT;

CREATE INDEX "CompanyRegimen_companyId_active_idx"
  ON "CompanyRegimen"("companyId", "active");
