import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: prismaMock.transaction },
}));

import {
  prismaSatNativeCredentialStore,
  SAT_NATIVE_PILOT_PURPOSE,
} from "./credential-broker";

const NOW = new Date("2026-09-08T18:00:00.000Z");
const COMPANY = {
  id: "company-1",
  rfc: "AAA010101AAA",
  isActive: true,
  fielCer: "enc:v1:certificate",
  fielKey: "enc:v1:private-key",
  fielPassword: "enc:v1:password",
  fielVigencia: null,
};
const OPERATOR = {
  id: "operator-1",
  email: "operator@example.test",
  esOperador: true,
};

function prepareInput(runId = "b4a2c9ee-55b7-4ad5-a567-9ad5fb77f431") {
  return {
    authorizedRfc: COMPANY.rfc,
    operatorUserId: OPERATOR.id,
    runId,
    purpose: SAT_NATIVE_PILOT_PURPOSE,
    now: NOW,
  } as const;
}

function fakeTransaction(existingLease: Record<string, unknown>) {
  const tx = {
    user: { findUnique: vi.fn(async () => OPERATOR) },
    company: { findUnique: vi.fn(async () => COMPANY) },
    legalAcceptance: { findFirst: vi.fn(async () => ({ id: "mandate-1" })) },
    satNativePilotRun: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async () => ({ runId: prepareInput().runId })),
    },
    auditLog: {
      create: vi.fn(async (_input: {
        data: {
          accion: string;
          detalle: Record<string, unknown>;
        };
      }) => ({ id: "audit-1" })),
    },
    $queryRaw: vi.fn()
      .mockResolvedValueOnce([existingLease])
      .mockResolvedValueOnce([{ companyId: COMPANY.id }]),
  };
  prismaMock.transaction.mockImplementationOnce(
    async (callback: (client: typeof tx) => unknown) => callback(tx),
  );
  return tx;
}

describe("Prisma SAT native credential store lease takeover", () => {
  beforeEach(() => {
    prismaMock.transaction.mockReset();
  });

  it("terminates and audits an expired owner before starting its replacement", async () => {
    const previousRunId = "45b4ec29-06c9-4c68-b50e-a05cd4ef44a1";
    const tx = fakeTransaction({
      runId: previousRunId,
      operatorUserId: OPERATOR.id,
      purpose: SAT_NATIVE_PILOT_PURPOSE,
      status: "RUNNING",
      expiresAt: new Date("2026-09-08T17:59:00.000Z"),
      databaseNow: NOW,
      expired: true,
    });

    await expect(prismaSatNativeCredentialStore.prepare(prepareInput()))
      .resolves.toMatchObject({ companyId: COMPANY.id, rfc: COMPANY.rfc });

    expect(tx.satNativePilotRun.updateMany).toHaveBeenCalledWith({
      where: {
        runId: previousRunId,
        companyId: COMPANY.id,
        operatorUserId: OPERATOR.id,
        purpose: SAT_NATIVE_PILOT_PURPOSE,
        status: "RUNNING",
      },
      data: {
        status: "EXPIRED",
        finishedAt: NOW,
        outcomeCode: "LEASE_EXPIRED",
      },
    });
    expect(tx.auditLog.create.mock.calls.map((call) => call[0].data.accion))
      .toEqual([
        "sat-native.fiel-use-expired",
        "sat-native.fiel-use-started",
      ]);
    expect(tx.auditLog.create.mock.calls[0][0].data.detalle).toMatchObject({
      runId: previousRunId,
      outcomeCode: "LEASE_EXPIRED",
      replacementRunId: prepareInput().runId,
    });
  });

  it("does not supersede an unexpired running lease", async () => {
    const tx = fakeTransaction({
      runId: "45b4ec29-06c9-4c68-b50e-a05cd4ef44a1",
      operatorUserId: OPERATOR.id,
      purpose: SAT_NATIVE_PILOT_PURPOSE,
      status: "RUNNING",
      expiresAt: new Date("2026-09-08T18:01:00.000Z"),
      databaseNow: NOW,
      expired: false,
    });

    await expect(prismaSatNativeCredentialStore.prepare(prepareInput()))
      .rejects.toMatchObject({ code: "RUN_IN_PROGRESS" });

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.satNativePilotRun.updateMany).not.toHaveBeenCalled();
    expect(tx.satNativePilotRun.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("fails closed when the expired run record cannot be terminated", async () => {
    const tx = fakeTransaction({
      runId: "45b4ec29-06c9-4c68-b50e-a05cd4ef44a1",
      operatorUserId: OPERATOR.id,
      purpose: SAT_NATIVE_PILOT_PURPOSE,
      status: "RUNNING",
      expiresAt: new Date("2026-09-08T17:59:00.000Z"),
      databaseNow: NOW,
      expired: true,
    });
    tx.satNativePilotRun.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(prismaSatNativeCredentialStore.prepare(prepareInput()))
      .rejects.toMatchObject({ code: "UNEXPECTED" });

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.satNativePilotRun.create).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });
});
