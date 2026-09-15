import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  membership: vi.fn(),
  invoiceFindUnique: vi.fn(),
  assignmentFindUnique: vi.fn(),
  assignmentDeleteMany: vi.fn(),
  transaction: vi.fn(),
  assignmentCreate: vi.fn(),
  assignmentUpdateMany: vi.fn(),
  allocationDeleteMany: vi.fn(),
  assignmentFindUniqueOrThrow: vi.fn(),
  allocationCreateMany: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/authz", () => ({ getEffectiveCompanyMembership: mocks.membership }));
vi.mock("@/lib/audit", () => ({ registrarBitacora: mocks.audit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    invoice: { findUnique: mocks.invoiceFindUnique },
    invoiceRegimenAssignment: {
      findUnique: mocks.assignmentFindUnique,
      deleteMany: mocks.assignmentDeleteMany,
    },
    $transaction: mocks.transaction,
  },
}));

import { DELETE, GET, PUT } from "./route";

const params = { params: Promise.resolve({ id: "invoice-1" }) };

function baseInvoice(extra: Record<string, unknown> = {}) {
  return {
    id: "invoice-1",
    companyId: "company-1",
    tipo: "INGRESO",
    fecha: new Date("2026-08-10T00:00:00.000Z"),
    serie: "A",
    folio: "42",
    uuid: "uuid-1",
    company: {
      regimenFiscal: "612",
      regimenes: [
        { code: "612", since: new Date("2024-01-01T00:00:00.000Z"), endedAt: null, active: true },
        { code: "606", since: new Date("2025-01-01T00:00:00.000Z"), endedAt: null, active: true },
      ],
    },
    regimenAssignment: null,
    ...extra,
  };
}

function reviewedAssignment(revision = 1) {
  return {
    id: "assignment-1",
    invoiceId: "invoice-1",
    revision,
    reviewedById: "user-1",
    reviewedByEmail: "contador@example.com",
    reviewedAt: new Date("2026-09-15T12:00:00.000Z"),
    note: "Revisado contra papeles de trabajo",
    createdAt: new Date("2026-09-15T12:00:00.000Z"),
    updatedAt: new Date("2026-09-15T12:00:00.000Z"),
    allocations: [
      { id: "allocation-1", assignmentId: "assignment-1", regimenCode: "612", basisPoints: 6_000 },
      { id: "allocation-2", assignmentId: "assignment-1", regimenCode: "606", basisPoints: 4_000 },
    ],
  };
}

function request(method: string, body?: unknown) {
  return new Request("http://localhost/api/facturas/invoice-1/asignacion-regimen", {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function fakeTransactionClient() {
  return {
    invoiceRegimenAssignment: {
      create: mocks.assignmentCreate,
      updateMany: mocks.assignmentUpdateMany,
      findUniqueOrThrow: mocks.assignmentFindUniqueOrThrow,
    },
    invoiceRegimenAllocation: {
      deleteMany: mocks.allocationDeleteMany,
      createMany: mocks.allocationCreateMany,
    },
  };
}

describe("/api/facturas/[id]/asignacion-regimen", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: "user-1", email: "contador@example.com" } });
    mocks.membership.mockResolvedValue({ role: "ACCOUNTANT" });
    mocks.assignmentCreate.mockResolvedValue({ id: "assignment-1" });
    mocks.assignmentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.allocationDeleteMany.mockResolvedValue({ count: 2 });
    mocks.assignmentFindUniqueOrThrow.mockResolvedValue({ id: "assignment-1" });
    mocks.allocationCreateMany.mockResolvedValue({ count: 2 });
    mocks.assignmentDeleteMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (callback) => callback(fakeTransactionClient()));
  });

  it("returns 401 before reading invoice data", async () => {
    mocks.auth.mockResolvedValue(null);

    const response = await GET(request("GET"), params);

    expect(response.status).toBe(401);
    expect(mocks.invoiceFindUnique).not.toHaveBeenCalled();
  });

  it("lets a viewer inspect a complete reviewed assignment", async () => {
    mocks.membership.mockResolvedValue({ role: "VIEWER" });
    mocks.invoiceFindUnique.mockResolvedValue(baseInvoice({
      regimenAssignment: reviewedAssignment(),
    }));

    const response = await GET(request("GET"), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      periodo: "2026-08",
      asignable: true,
      estado: "COMPLETA",
      usadaEnCalculoAutomatico: false,
      regimenesDisponibles: [
        { code: "612", label: expect.any(String) },
        { code: "606", label: expect.any(String) },
      ],
      asignacion: {
        revision: 1,
        allocations: [
          { regimenCode: "612", basisPoints: 6_000, porcentaje: 60 },
          { regimenCode: "606", basisPoints: 4_000, porcentaje: 40 },
        ],
      },
    });
  });

  it("marks a stored assignment for review when regime evidence changed", async () => {
    mocks.invoiceFindUnique.mockResolvedValue(baseInvoice({
      company: {
        regimenFiscal: "612",
        regimenes: [
          { code: "612", since: new Date("2024-01-01T00:00:00.000Z"), endedAt: null, active: true },
        ],
      },
      regimenAssignment: reviewedAssignment(),
    }));

    const response = await GET(request("GET"), params);

    await expect(response.json()).resolves.toMatchObject({
      estado: "REQUIERE_REVISION",
      observacion: { code: "REGIME_OUTSIDE_PERIOD" },
      usadaEnCalculoAutomatico: false,
    });
  });

  it("blocks VIEWER writes", async () => {
    mocks.membership.mockResolvedValue({ role: "VIEWER" });
    mocks.invoiceFindUnique.mockResolvedValue(baseInvoice());

    const response = await PUT(request("PUT", {
      expectedRevision: 0,
      allocations: [{ regimenCode: "612", basisPoints: 10_000 }],
    }), params);

    expect(response.status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("rejects payment CFDIs because they carry no ISR base to attribute", async () => {
    mocks.invoiceFindUnique.mockResolvedValue(baseInvoice({ tipo: "PAGO" }));

    const response = await PUT(request("PUT", {
      expectedRevision: 0,
      allocations: [{ regimenCode: "612", basisPoints: 10_000 }],
    }), params);

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "INVOICE_TYPE_NOT_ASSIGNABLE" });
  });

  it("rejects incomplete or out-of-period allocation sets before writing", async () => {
    mocks.invoiceFindUnique.mockResolvedValue(baseInvoice());

    const incomplete = await PUT(request("PUT", {
      expectedRevision: 0,
      allocations: [{ regimenCode: "612", basisPoints: 9_999 }],
    }), params);
    expect(incomplete.status).toBe(422);
    await expect(incomplete.json()).resolves.toMatchObject({ code: "INCOMPLETE_ALLOCATION" });

    const outsidePeriod = await PUT(request("PUT", {
      expectedRevision: 0,
      allocations: [{ regimenCode: "626", basisPoints: 10_000 }],
    }), params);
    expect(outsidePeriod.status).toBe(422);
    await expect(outsidePeriod.json()).resolves.toMatchObject({ code: "REGIME_OUTSIDE_PERIOD" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("creates revision 1 atomically and records append-only audit metadata", async () => {
    mocks.invoiceFindUnique
      .mockResolvedValueOnce(baseInvoice())
      .mockResolvedValueOnce(baseInvoice({ regimenAssignment: reviewedAssignment() }));

    const response = await PUT(request("PUT", {
      expectedRevision: 0,
      note: "  Revisado contra papeles de trabajo  ",
      allocations: [
        { regimenCode: "612", basisPoints: 6_000 },
        { regimenCode: "606", basisPoints: 4_000 },
      ],
    }), params);

    expect(response.status).toBe(200);
    expect(mocks.assignmentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        invoiceId: "invoice-1",
        revision: 1,
        reviewedById: "user-1",
        reviewedByEmail: "contador@example.com",
        note: "Revisado contra papeles de trabajo",
        allocations: {
          create: [
            { regimenCode: "612", basisPoints: 6_000 },
            { regimenCode: "606", basisPoints: 4_000 },
          ],
        },
      }),
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      accion: "factura.asignar-regimen",
      entidadId: "invoice-1",
      detalle: expect.objectContaining({ revisionAnterior: 0, revisionNueva: 1 }),
    }));
  });

  it("replaces an existing allocation only at the expected revision", async () => {
    mocks.invoiceFindUnique
      .mockResolvedValueOnce(baseInvoice({ regimenAssignment: reviewedAssignment(2) }))
      .mockResolvedValueOnce(baseInvoice({ regimenAssignment: {
        ...reviewedAssignment(3),
        allocations: [
          { id: "allocation-3", assignmentId: "assignment-1", regimenCode: "606", basisPoints: 10_000 },
        ],
      } }));

    const response = await PUT(request("PUT", {
      expectedRevision: 2,
      allocations: [{ regimenCode: "606", basisPoints: 10_000 }],
    }), params);

    expect(response.status).toBe(200);
    expect(mocks.assignmentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { invoiceId: "invoice-1", revision: 2 },
      data: expect.objectContaining({ revision: { increment: 1 } }),
    }));
    expect(mocks.allocationDeleteMany).toHaveBeenCalledWith({
      where: { assignment: { invoiceId: "invoice-1" } },
    });
    expect(mocks.allocationCreateMany).toHaveBeenCalledWith({
      data: [{ assignmentId: "assignment-1", regimenCode: "606", basisPoints: 10_000 }],
    });
  });

  it("returns 409 instead of overwriting a newer accountant revision", async () => {
    mocks.invoiceFindUnique.mockResolvedValue(baseInvoice({ regimenAssignment: reviewedAssignment(2) }));
    mocks.assignmentUpdateMany.mockResolvedValue({ count: 0 });
    mocks.assignmentFindUnique.mockResolvedValue({ revision: 3 });

    const response = await PUT(request("PUT", {
      expectedRevision: 2,
      allocations: [{ regimenCode: "612", basisPoints: 10_000 }],
    }), params);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "REVISION_CONFLICT",
      currentRevision: 3,
    });
    expect(mocks.allocationDeleteMany).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("removes only the reviewed revision and returns to SIN_ASIGNAR", async () => {
    mocks.invoiceFindUnique
      .mockResolvedValueOnce(baseInvoice({ regimenAssignment: reviewedAssignment(2) }))
      .mockResolvedValueOnce(baseInvoice());

    const response = await DELETE(request("DELETE", { expectedRevision: 2 }), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.assignmentDeleteMany).toHaveBeenCalledWith({
      where: { invoiceId: "invoice-1", revision: 2 },
    });
    expect(body).toMatchObject({
      estado: "SIN_ASIGNAR",
      asignacion: null,
      usadaEnCalculoAutomatico: false,
    });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      accion: "factura.quitar-asignacion-regimen",
      detalle: { revisionEliminada: 2 },
    }));
  });
});
