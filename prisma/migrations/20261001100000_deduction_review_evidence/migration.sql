-- Additive, append-only evidence records. No tax state or historical data changes.
CREATE TABLE "FiscalDeductionReview" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "periodo" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "regimenCode" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "decision" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "references" TEXT[] NOT NULL,
  "evidenceHash" TEXT NOT NULL,
  "snapshot" JSONB NOT NULL,
  "requestId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "reviewedById" TEXT NOT NULL,
  "reviewedByEmail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FiscalDeductionReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "DeductionReview_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "DeductionReview_source_check" CHECK ("source" IN ('PUE_DOCUMENTADO', 'PPD_REP')),
  CONSTRAINT "DeductionReview_decision_check" CHECK ("decision" IN ('DOCUMENTADA', 'NO_PROPONER', 'PENDIENTE'))
);
CREATE TABLE "FiscalRegimeElection" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "regimenCode" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "choice" TEXT NOT NULL,
  "effectiveFrom" TEXT NOT NULL,
  "effectiveTo" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "references" TEXT[] NOT NULL,
  "contextHash" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "reviewedById" TEXT NOT NULL,
  "reviewedByEmail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FiscalRegimeElection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RegimeElection_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "RegimeElection_choice_check" CHECK (
    ("regimenCode" = '606' AND "choice" IN ('COMPROBADAS', 'OPCIONAL_35', 'PENDIENTE')) OR
    ("regimenCode" = '625' AND "choice" IN ('PROVISIONAL', 'DEFINITIVO', 'PENDIENTE'))
  )
);
CREATE UNIQUE INDEX "DeductionReview_scope_revision_key" ON "FiscalDeductionReview"("companyId", "periodo", "invoiceId", "source", "regimenCode", "revision");
CREATE UNIQUE INDEX "FiscalDeductionReview_companyId_requestId_key" ON "FiscalDeductionReview"("companyId", "requestId");
CREATE UNIQUE INDEX "FiscalRegimeElection_companyId_year_regimenCode_revision_key" ON "FiscalRegimeElection"("companyId", "year", "regimenCode", "revision");
CREATE UNIQUE INDEX "FiscalRegimeElection_companyId_requestId_key" ON "FiscalRegimeElection"("companyId", "requestId");
ALTER TABLE "FiscalDeductionReview" ADD CONSTRAINT "FiscalDeductionReview_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FiscalRegimeElection" ADD CONSTRAINT "FiscalRegimeElection_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
