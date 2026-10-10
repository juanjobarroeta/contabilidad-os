import { describe, it, expect, vi, beforeEach } from "vitest";

const getEffectiveCompanyMembership = vi.fn();
const requireUser = vi.fn();
vi.mock("@/lib/authz", () => ({
  getEffectiveCompanyMembership: (...a: unknown[]) => getEffectiveCompanyMembership(...a),
  requireUser: (...a: unknown[]) => requireUser(...a),
}));

import { requireBancosAccess, BancosAccessError, sesionOBearer } from "./access";

describe("sesionOBearer", () => {
  it("acepta el bearer de un satélite (HospitalOS) con la forma de auth()", async () => {
    requireUser.mockResolvedValueOnce({ id: "u1", email: "a@b.c" });
    const req = new Request("http://x", { headers: { authorization: "Bearer t" } });
    await expect(sesionOBearer(req)).resolves.toEqual({ user: { id: "u1", email: "a@b.c" } });
    expect(requireUser).toHaveBeenCalledWith(req);
  });
  it("sin sesión ni token válido → null (la ruta responde 401)", async () => {
    requireUser.mockRejectedValueOnce(new Error("401"));
    await expect(sesionOBearer(new Request("http://x"))).resolves.toBeNull();
  });
});

describe("requireBancosAccess", () => {
  beforeEach(() => getEffectiveCompanyMembership.mockReset());

  it("usa la membresía efectiva SIN negar al operador (default override)", async () => {
    getEffectiveCompanyMembership.mockResolvedValue({ role: "OWNER" });
    await expect(requireBancosAccess("u", "c")).resolves.toEqual({ canWrite: true, role: "OWNER" });
    expect(getEffectiveCompanyMembership).toHaveBeenCalledWith("u", "c");
  });

  it("VIEWER puede ver pero no escribir", async () => {
    getEffectiveCompanyMembership.mockResolvedValue({ role: "VIEWER" });
    await expect(requireBancosAccess("u", "c")).resolves.toMatchObject({ canWrite: false });
  });

  it("sin membresía → 403", async () => {
    getEffectiveCompanyMembership.mockResolvedValue(null);
    await expect(requireBancosAccess("u", "c")).rejects.toBeInstanceOf(BancosAccessError);
  });
});
