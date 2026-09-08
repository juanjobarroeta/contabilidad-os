-- Single-flight lease for the worker-only native SAT evidence pilot.
-- Contains operational identifiers only; never SAT credentials or portal state.
CREATE TABLE "SatNativePilotLease" (
    "companyId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "acknowledgement" TEXT NOT NULL,
    "executionScope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "outcomeCode" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SatNativePilotLease_pkey" PRIMARY KEY ("companyId")
);

CREATE INDEX "SatNativePilotLease_expiresAt_idx"
ON "SatNativePilotLease"("expiresAt");

-- A run UUID is append-only so the same supervised authorization cannot be
-- replayed after the company lease is released or expires.
CREATE TABLE "SatNativePilotRun" (
    "runId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "acknowledgement" TEXT NOT NULL,
    "executionScope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "outcomeCode" TEXT,

    CONSTRAINT "SatNativePilotRun_pkey" PRIMARY KEY ("runId")
);

CREATE INDEX "SatNativePilotRun_companyId_startedAt_idx"
ON "SatNativePilotRun"("companyId", "startedAt");
