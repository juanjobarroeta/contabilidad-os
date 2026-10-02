import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ userId: "itest-onb-owner" }));
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: mock.userId, email: `${mock.userId}@test.invalid` } }) }));
import { prisma } from "@/lib/prisma";
import { GET as readProgress, PATCH as saveProgress } from "@/app/api/onboarding/progreso/route";
import { GET as context } from "@/app/api/onboarding/contexto/route";
import { GET as invitations } from "@/app/api/invitations/pendientes/route";
import { POST as createBank } from "@/app/api/bancos/route";
import { PATCH as updateBank } from "@/app/api/bancos/[id]/route";
import { PROGRESO_INICIAL } from "./progreso";

const U = "itest-onb-owner", F = "itest-onb-accountant", V = "itest-onb-invited", X = "itest-onb-outsider";
const D = "itest-onb-firm", E = "itest-onb-other-firm";
const A = "itest-onb-company-a", B = "itest-onb-company-b", C = "itest-onb-company-c", I = "itest-onb-inactive";
const skip = process.env.DB_TESTS_SKIP === "1";
const req = (body: unknown) => new Request("https://app.test/api/onboarding/progreso", { method: "PATCH", body: JSON.stringify(body) });
const save = (body: unknown) => saveProgress(req(body));
const read = async () => (await readProgress(new Request("https://app.test/api/onboarding/progreso"))).json();
async function clean() {
  await prisma.company.deleteMany({ where: { id: { in: [A, B, C, I] } } });
  await prisma.despacho.deleteMany({ where: { id: { in: [D, E] } } });
  await prisma.user.deleteMany({ where: { id: { in: [U, F, V, X] } } });
}
describe.skipIf(skip)("onboarding recovery with real concurrent DB writes", () => {
  beforeAll(async () => {
    await clean();
    await prisma.user.createMany({ data: [U, F, V, X].map(id => ({ id, email: `${id}@test.invalid` })) });
    await prisma.despacho.createMany({ data: [D, E].map(id => ({ id, name: id })) });
    await prisma.company.createMany({ data: [A, B, C, I].map((id, i) => ({ id, rfc: `TOB26100200${i}`, razonSocial: id, regimenFiscal: "601", codigoPostal: "06600", despachoId: id === C ? E : D, isActive: id !== I })) });
    await prisma.companyMember.createMany({ data: [{ userId: U, companyId: A, role: "OWNER" }, { userId: U, companyId: I, role: "OWNER" }] });
    await prisma.despachoMember.create({ data: { id: "itest-onb-firm-member", userId: F, despachoId: D, role: "ACCOUNTANT", companyScopes: { create: { companyId: B } } } });
    await prisma.companyInvitation.create({ data: { companyId: A, despachoId: D, invitedByUserId: U, email: `${V}@test.invalid`, tokenHash: "synthetic-onboarding-recovery-invitation", expiresAt: new Date(Date.now() + 86400000) } });
  });
  afterAll(clean);
  beforeEach(async () => {
    mock.userId = U;
    await prisma.user.updateMany({ where: { id: { in: [U, F, V, X] } }, data: { onboarding: { ...PROGRESO_INICIAL } } });
  });
  it("retains the profile, tone, and step when separate saves arrive together", async () => {
    for (let i = 0; i < 12; i++) {
      await prisma.user.update({ where: { id: U }, data: { onboarding: { ...PROGRESO_INICIAL } } });
      const results = await Promise.all([save({ perfil: "empresa", tono: "calma" }), save({ paso: "personaje" })]);
      expect(results.map(r => r.status)).toEqual([200, 200]);
      expect((await read()).progreso).toMatchObject({ perfil: "empresa", tono: "calma", paso: "personaje" });
    }
  });
  it("keeps add-company progress independent of preferences and first-run completion", async () => {
    await save({ paso: "listo", perfil: "empresa", tono: "grano", companyId: A });
    await save({ flujo: "agregar", reiniciar: true, paso: "fiel", returnTo: "/configuracion/empresas" });
    const results = await Promise.all([save({ flujo: "agregar", paso: "historial", companyId: A }), save({ tono: "calma" })]);
    expect(results.every(r => r.ok)).toBe(true);
    expect(await read()).toMatchObject({
      progreso: { paso: "listo", perfil: "empresa", tono: "calma", companyId: A },
      agregar: { paso: "historial", companyId: A, returnTo: "/configuracion/empresas" },
    });
    await save({ flujo: "agregar", paso: "listo" });
    await save({ flujo: "agregar", reiniciar: true, paso: "fiel", companyId: null });
    expect((await read()).agregar).toMatchObject({ paso: "fiel", companyId: null });
  });
  it("rejects unknown flow payloads and external return destinations", async () => {
    expect((await save({ flujo: "invalid" })).status).toBe(400);
    expect((await save([])).status).toBe(400);
    await save({ flujo: "agregar", returnTo: "//external.test" });
    expect((await read()).agregar.returnTo).toBeNull();
  });
  it("counts active direct and scoped firm access; permits progress only within that scope", async () => {
    expect((await (await context()).json()).empresas).toBe(1); // inactive company excluded
    mock.userId = F;
    expect((await (await context()).json()).empresas).toBe(1); // B through firm, no direct membership
    expect((await save({ companyId: B, paso: "historial" })).status).toBe(200);
    for (const companyId of [A, C, I]) expect((await save({ flujo: "agregar", companyId })).status).toBe(404);
    mock.userId = X;
    expect((await (await context()).json()).empresas).toBe(0);
    expect((await save({ companyId: A })).status).toBe(404);
  });
  it("deduplicates direct and inherited access and excludes inactive companies", async () => {
    await prisma.companyMember.create({ data: { userId: F, companyId: B, role: "VIEWER" } });
    mock.userId = F;
    expect((await (await context()).json()).empresas).toBe(1);
    await prisma.companyMember.deleteMany({ where: { userId: F } });
  });
  it("returns a pending client invitation without exposing its token", async () => {
    mock.userId = V;
    const data = await (await invitations()).json();
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ empresa: A, despacho: D });
    expect(JSON.stringify(data)).not.toContain("synthetic-onboarding-recovery-invitation");
  });
  it("rejects invalid bank identifiers before inserts or updates and accepts a valid CLABE", async () => {
    const input = { companyId: A, banco: "Synthetic", nombre: "Test", numeroCuenta: "onboarding-clabe-test" };
    for (const clabe of ["123", "002115016003269412"]) {
      expect((await createBank(req({ ...input, clabe }))).status).toBe(400);
      expect(await prisma.bankAccount.count({ where: { companyId: A } })).toBe(0);
    }
    const res = await createBank(req({ ...input, clabe: "002115016003269411" }));
    expect(res.status).toBe(201);
    const bank = await res.json();
    const params = { params: Promise.resolve({ id: bank.id }) };
    expect((await updateBank(req({ clabe: "123" }), params)).status).toBe(400);
    expect((await prisma.bankAccount.findUniqueOrThrow({ where: { id: bank.id } })).clabe).toBe("002115016003269411");
    expect((await updateBank(req({ clabe: "" }), params)).status).toBe(200);
    expect((await prisma.bankAccount.findUniqueOrThrow({ where: { id: bank.id } })).clabe).toBeNull();
  });
});
