import { describe, it, expect, vi, beforeEach } from "vitest";

const getEffectiveCompanyMembership = vi.fn();
vi.mock("@/lib/authz", () => ({ getEffectiveCompanyMembership: (...a: unknown[]) => getEffectiveCompanyMembership(...a) }));

import { requireBancosAccess, BancosAccessError } from "./access";

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
