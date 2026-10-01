import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), membership: vi.fn(), module: vi.fn(), read: vi.fn(), history: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/authz", () => ({ requireMembership: mocks.membership, requireModule: mocks.module,
  AuthzError: class extends Error { constructor(public status: number, message: string) { super(message); } } }));
vi.mock("@/lib/fiscal/deduction-review", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fiscal/deduction-review")>();
  return { DeductionReviewError: actual.DeductionReviewError, readDeductionReviewWorkspace: mocks.read, readDeductionReviewHistory: mocks.history, saveDeductionReview: mocks.save };
});
import { GET, POST } from "@/app/api/impuestos/asignaciones-regimen/deducciones/revision/route";
import { DeductionReviewError } from "@/lib/fiscal/deduction-review";
import { AuthzError } from "@/lib/authz";
const body = () => ({ kind: "review", invoiceId: "inv-1", regimenCode: "612", source: "PUE_DOCUMENTADO", decision: "DOCUMENTADA",
  expectedRevision: 0, evidenceHash: "a".repeat(64), requestId: randomUUID(), reason: "Revisión sintética con evidencia del expediente.", references: ["Documento de prueba"], acknowledged: true });
function request(write = false, payload: unknown = body(), headers: Record<string, string> = {}) {
  return new Request("https://qa.invalid/api/impuestos/asignaciones-regimen/deducciones/revision?companyId=company-a&year=2026&month=9", write
    ? { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(payload) } : undefined);
}
beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ user: { id: "reviewer", email: "reviewer@test.invalid" } }); mocks.membership.mockResolvedValue({ membership: { role: "ACCOUNTANT", allowedModules: [], accessViaDespacho: false } }); mocks.read.mockResolvedValue({ deduccionAutorizadaCentavos: null }); mocks.save.mockResolvedValue({ revision: 1 }); });
describe("FISC-002O review API authorization and mutation boundary", () => {
  it.each([GET, POST])("authenticates before any company or fiscal reads", async (handler) => {
    mocks.auth.mockResolvedValue(null); const result = await handler(request(handler === POST));
    expect(result.status).toBe(401); expect(result.headers.get("cache-control")).toBe("no-store");
    expect(mocks.membership).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([GET, POST])("rejects another company before fiscal IO", async (handler) => {
    mocks.membership.mockRejectedValue(new AuthzError(403, "Sin acceso")); expect((await handler(request(handler === POST))).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("allows VIEWER reads but rejects all writes", async () => {
    mocks.membership.mockImplementation(async (_companyId, roles) => {
      if (roles) throw new AuthzError(403, "Sin permisos");
      return { membership: { role: "VIEWER", allowedModules: [], accessViaDespacho: false } };
    });
    const read = await GET(request()); expect(read.status).toBe(200); expect(await read.json()).toMatchObject({ puedeEditar: false });
    expect((await POST(request(true))).status).toBe(403); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each(["OWNER", "ADMIN", "ACCOUNTANT"])("permits %s and uses session identity only", async (role) => {
    mocks.membership.mockResolvedValue({ membership: { role, allowedModules: [], accessViaDespacho: false } }); const payload = body();
    expect((await POST(request(true, payload))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ companyId: "company-a", periodo: "2026-09" }), payload, { id: "reviewer", email: "reviewer@test.invalid" });
  });
  it("rejects satellite-only members before fiscal IO", async () => {
    mocks.membership.mockResolvedValue({ membership: { role: "ACCOUNTANT", allowedModules: ["CONSTRUCCION"], accessViaDespacho: false } });
    expect((await GET(request())).status).toBe(403); expect((await POST(request(true))).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("honors an independent effective despacho grant", async () => {
    mocks.membership.mockResolvedValue({ membership: { role: "ACCOUNTANT", allowedModules: ["CONSTRUCCION"], accessViaDespacho: true } });
    expect((await GET(request())).status).toBe(200);
  });
  it("rejects a disabled company accounting module before fiscal IO", async () => {
    mocks.module.mockRejectedValue(new AuthzError(403, "Módulo deshabilitado"));
    expect((await POST(request(true))).status).toBe(403); expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([{ origin: "https://hostile.invalid" }, { origin: "null" }, { "sec-fetch-site": "cross-site" }])("rejects cross-site writes %j", async (headers) => {
    expect((await POST(request(true, body(), headers))).status).toBe(403); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("rejects forged actor and approval fields", async () => {
    expect((await POST(request(true, { ...body(), reviewedById: "other", approved: true }))).status).toBe(400); expect(mocks.save).not.toHaveBeenCalled();
  });
  it("uses the original Host authority when Next normalizes loopback URLs", async () => {
    expect((await POST(request(true, body(), { host: "127.0.0.1:3218", origin: "http://127.0.0.1:3218", "x-forwarded-proto": "http" }))).status).toBe(200);
  });
  it("returns stable stale evidence conflicts without caching", async () => {
    mocks.save.mockRejectedValue(new DeductionReviewError(409, "EVIDENCE_CHANGED", "Recarga."));
    const response = await POST(request(true)); expect(response.status).toBe(409); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ code: "EVIDENCE_CHANGED" });
  });
  it("does not turn database errors into successful empty evidence", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.read.mockRejectedValue(new Error("Database unavailable")); const response = await GET(request());
    expect(response.status).toBe(500); expect(response.headers.get("cache-control")).toBe("no-store"); log.mockRestore();
  });
});
