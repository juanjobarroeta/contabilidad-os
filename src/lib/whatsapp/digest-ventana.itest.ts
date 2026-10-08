/**
 * Ventana de servicio de 24h del digest, contra Postgres real: sólo un mensaje
 * ENTRANTE (role USER) reciente del mismo link abre el freeform completo.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { dentroDeVentana } from "./digest";

const skip = process.env.DB_TESTS_SKIP === "1";
const U = "itest-dv-user";
const E = "itest-dv-emp";
const L1 = "itest-dv-link1";
const L2 = "itest-dv-link2";
const AHORA = new Date("2026-10-06T14:00:00Z");
const hace = (h: number) => new Date(AHORA.getTime() - h * 3600_000);

async function limpiar() {
  await prisma.whatsappLink.deleteMany({ where: { id: { in: [L1, L2] } } });
  await prisma.company.deleteMany({ where: { id: E } });
  await prisma.user.deleteMany({ where: { id: U } });
}

describe.skipIf(skip)("dentroDeVentana", () => {
  beforeAll(async () => {
    await limpiar();
    await prisma.user.create({ data: { id: U, email: `${U}@test.local` } });
    await prisma.company.create({ data: { id: E, rfc: "ITESTDVV010101AA1", razonSocial: "DV", regimenFiscal: "601", codigoPostal: "06600" } });
    await prisma.whatsappLink.createMany({
      data: [
        { id: L1, phoneE164: "+5210000000001", userId: U, verifiedAt: AHORA },
        { id: L2, phoneE164: "+5210000000002", userId: U, verifiedAt: AHORA },
      ],
    });
    const c1 = await prisma.whatsappConversation.create({ data: { linkId: L1, companyId: E } });
    const c2 = await prisma.whatsappConversation.create({ data: { linkId: L2, companyId: E } });
    await prisma.whatsappMessage.createMany({
      data: [
        { conversationId: c1.id, role: "USER", body: "hola", createdAt: hace(3) },
        // L2: entrante viejo + saliente reciente → fuera de ventana.
        { conversationId: c2.id, role: "USER", body: "hola", createdAt: hace(30) },
        { conversationId: c2.id, role: "ASSISTANT", body: "resumen", createdAt: hace(1) },
      ],
    });
  });
  afterAll(limpiar);

  it("entrante de hace 3h → dentro", async () => {
    expect(await dentroDeVentana(L1, AHORA)).toBe(true);
  });
  it("sólo salientes recientes no abren la ventana", async () => {
    expect(await dentroDeVentana(L2, AHORA)).toBe(false);
  });
  it("cerca del corte de 24h ya cuenta como fuera", async () => {
    expect(await dentroDeVentana(L1, new Date(AHORA.getTime() + 21 * 3600_000))).toBe(false);
  });
});
