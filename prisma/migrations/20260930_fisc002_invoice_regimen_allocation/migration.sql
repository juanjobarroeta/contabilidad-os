-- FISC-002: explicit, accountant-reviewed ISR attribution for mixed-regime
-- income/expense CFDIs. This is additive and does not change calculations.
CREATE TABLE "InvoiceRegimenAssignment" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "reviewedById" TEXT NOT NULL,
  "reviewedByEmail" TEXT,
  "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InvoiceRegimenAssignment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InvoiceRegimenAssignment_revision_check" CHECK ("revision" >= 1)
);

CREATE TABLE "InvoiceRegimenAllocation" (
  "id" TEXT NOT NULL,
  "assignmentId" TEXT NOT NULL,
  "regimenCode" TEXT NOT NULL,
  "basisPoints" INTEGER NOT NULL,

  CONSTRAINT "InvoiceRegimenAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InvoiceRegimenAllocation_basisPoints_check"
    CHECK ("basisPoints" BETWEEN 1 AND 10000)
);

CREATE UNIQUE INDEX "InvoiceRegimenAssignment_invoiceId_key"
  ON "InvoiceRegimenAssignment"("invoiceId");

CREATE UNIQUE INDEX "InvoiceRegimenAllocation_assignmentId_regimenCode_key"
  ON "InvoiceRegimenAllocation"("assignmentId", "regimenCode");

ALTER TABLE "InvoiceRegimenAssignment"
  ADD CONSTRAINT "InvoiceRegimenAssignment_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InvoiceRegimenAllocation"
  ADD CONSTRAINT "InvoiceRegimenAllocation_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "InvoiceRegimenAssignment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
