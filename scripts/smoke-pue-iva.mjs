// Local-only acceptance: real UI/API, synthetic fixtures, no PAC/SAT requests.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { encode } from "next-auth/jwt";
import { chromium } from "playwright";

const dbUrl = new URL(
  process.env.TEST_DATABASE_URL ?? "postgresql://invalid/blocked",
);
const origin = new URL(process.env.PUE_SMOKE_ORIGIN ?? "http://127.0.0.1:3219");
assert(
  ["localhost", "127.0.0.1"].includes(dbUrl.hostname) &&
    /test/i.test(dbUrl.pathname),
  "Disposable local test DB required",
);
assert(
  ["localhost", "127.0.0.1"].includes(origin.hostname) &&
    origin.protocol === "http:",
  "Local HTTP origin required",
);
assert(
  process.env.AUTH_SECRET?.startsWith("pue-iva-synthetic-"),
  "Dedicated synthetic AUTH_SECRET required",
);
const prisma = new PrismaClient({ datasourceUrl: dbUrl.href });
const id = `pue-browser-${randomUUID()}`;
const users = [`${id}-owner`, `${id}-viewer`];
const out = process.env.PUE_SMOKE_ARTIFACTS ?? "/tmp/cos-pue-browser";
let browser;
const failures = [];

async function contextFor(index) {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 1000 },
  });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin.origin
      ? route.continue()
      : route.abort(),
  );
  const token = await encode({
    secret: process.env.AUTH_SECRET,
    salt: "authjs.session-token",
    maxAge: 3600,
    token: {
      sub: users[index],
      id: users[index],
      email: `${index}@pue.invalid`,
      name: "Synthetic IVA reviewer",
    },
  });
  await context.addCookies([
    {
      name: "authjs.session-token",
      value: token,
      url: origin.origin,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return context;
}
try {
  await mkdir(out, { recursive: true });
  await prisma.user.createMany({
    data: users.map((userId, index) => ({
      id: userId,
      email: `${id}-${index}@pue.invalid`,
      name: "Synthetic IVA reviewer",
    })),
  });
  await prisma.legalAcceptance.createMany({
    data: users.flatMap((userId) =>
      ["TERMINOS", "AVISO_PRIVACIDAD"].map((documento) => ({
        userId,
        documento,
        version: "2026-09-03",
        contexto: "synthetic-browser-test",
      })),
    ),
  });
  await prisma.company.create({
    data: {
      id,
      rfc: "PUE261001AA1",
      razonSocial: "PUE IVA SYNTHETIC ONLY",
      regimenFiscal: "601",
      codigoPostal: "06600",
      modules: { create: { modulo: "CONTABILIDAD", habilitado: true } },
      members: {
        create: users.map((userId, index) => ({
          userId,
          role: index ? "VIEWER" : "OWNER",
        })),
      },
    },
  });
  const invoice = await prisma.invoice.create({
    data: {
      companyId: id,
      tipo: "INGRESO",
      tipoSat: "I",
      status: "STAMPED",
      uuid: randomUUID(),
      fecha: new Date("2026-10-01T12:00:00Z"),
      metodoPago: "PUE",
      formaPago: "03",
      usoCfdi: "G03",
      moneda: "MXN",
      subtotal: 12500,
      total: 14500,
      taxes: {
        create: {
          tipo: "IVA",
          factor: "TASA",
          tasa: 0.16,
          base: 12500,
          importe: 2000,
        },
      },
      items: {
        create: {
          cantidad: 1,
          claveUnidad: "E48",
          claveProdServ: "84121500",
          descripcion: "Intereses de mutuo sintético",
          valorUnitario: 12500,
          importe: 12500,
        },
      },
    },
  });
  browser = await chromium.launch({ headless: true });
  const owner = await contextFor(0),
    page = await owner.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(
    new URL("/impuestos/papeles?month=10&year=2026", origin).href,
    { waitUntil: "domcontentloaded", timeout: 90_000 },
  );
  await page
    .getByRole("button", { name: "Revisar cobro", exact: true })
    .click();
  const form = page.getByRole("form", { name: "Revisar cobro e IVA" });
  await form.getByLabel("Tratamiento revisado").selectOption("FLUJO_GENERAL");
  await form.getByRole("checkbox").check();
  await form.getByLabel("Fecha efectiva del cobro completo").fill("2026-09-30");
  await form
    .getByLabel("Referencia del documento que acredita el cobro")
    .fill("Synthetic receipt September 30, folio 42");
  await form
    .getByLabel("Motivo y fundamento de la revisión")
    .fill(
      "Synthetic review: ordinary collection under LIVA 1-B; verified no special 18-A treatment and correct invoice tax.",
    );
  await form.screenshot({ path: `${out}/review-desktop.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await form.scrollIntoViewIfNeeded();
  assert(
    await form.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    "Review form must fit mobile",
  );
  await form.screenshot({ path: `${out}/review-mobile.png` });
  await form
    .getByRole("button", { name: "Confirmar revisión", exact: true })
    .click();
  await form.waitFor({ state: "hidden" });
  const url = (month) =>
    new URL(`/api/papeles/iva?companyId=${id}&year=2026&month=${month}`, origin)
      .href;
  const october = await (await owner.request.get(url(10))).json();
  const september = await (await owner.request.get(url(9))).json();
  assert.equal(september.totales.trasladado, 2000);
  assert.equal(october.totales.trasladado, 0);
  assert.equal(september.cobrosPue.determinado, true);
  assert.equal(
    await prisma.auditLog.count({
      where: { companyId: id, accion: "factura.iva-cobro-revisado" },
    }),
    1,
  );
  assert.equal(
    await prisma.taxDeclaration.count({ where: { companyId: id } }),
    0,
  );
  assert.equal(
    await prisma.accountingEntry.count({ where: { companyId: id } }),
    0,
  );
  console.log(
    "PASS real review form: September IVA 2000 / October 0, audited, no saved return or journal changed",
  );
  await page.setViewportSize({ width: 1365, height: 1000 });
  await page.goto(
    new URL("/impuestos/papeles?month=9&year=2026", origin).href,
    { waitUntil: "domcontentloaded" },
  );
  await page
    .getByRole("button", { name: "Revisar cobro", exact: true })
    .waitFor();
  await page.screenshot({
    path: `${out}/september-workpaper.png`,
    fullPage: true,
  });
  const viewer = await contextFor(1),
    viewerPage = await viewer.newPage();
  await viewerPage.goto(
    new URL("/impuestos/papeles?month=9&year=2026", origin).href,
    { waitUntil: "domcontentloaded", timeout: 90_000 },
  );
  await viewerPage
    .getByRole("heading", { name: "IVA trasladado (cobrado)", exact: true })
    .waitFor();
  assert.equal(
    await viewerPage
      .getByRole("button", { name: "Revisar cobro", exact: true })
      .count(),
    0,
  );
  const forbidden = await viewer.request.post(
    new URL(`/api/facturas/${invoice.id}/iva-cobro`, origin).href,
    {
      data: {
        companyId: id,
        expected: september.trasladado[0].fingerprint,
        tratamiento: "FLUJO_GENERAL",
        motivo: "Viewer must not confirm a review",
        fechaCobro: null,
        evidencia: null,
      },
    },
  );
  assert.equal(forbidden.status(), 403);
  console.log("PASS viewer has no review action and API denies writes");
  const hydrated = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === `/api/companies/${id}/facturapi/status`,
  );
  await page.goto(new URL("/facturas/nueva", origin).href, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await hydrated;
  const stampDate = page.getByLabel(
    "Fecha y hora de generación del CFDI (opcional)",
  );
  await stampDate.waitFor();
  assert.equal(await stampDate.inputValue(), "");
  await stampDate.fill("2026-10-01T09:30");
  const zone = page.getByLabel(/Huso horario del lugar de expedición/);
  assert.equal(await zone.inputValue(), "");
  await zone.selectOption("-06:00");
  const attestation = page.getByRole("checkbox", {
    name: /Confirmo la fecha y hora reales/,
  });
  await attestation.check();
  await stampDate.fill("2026-10-01T09:31");
  assert.equal(await attestation.isChecked(), false);
  await stampDate.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${out}/generation-controls.png`,
    fullPage: true,
  });
  console.log(
    "PASS generation timestamp starts blank, requires explicit zone, resets attestation when edited; no stamping performed",
  );
  assert.deepEqual(failures, []);
  console.log(`PASS browser smoke; screenshots: ${out}`);
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page
      .screenshot({ path: `${out}/failure.png`, fullPage: true })
      .catch(() => {});
    console.error((await page.locator("body").innerText()).slice(-4000));
  }
  throw error;
} finally {
  await browser?.close();
  await prisma.auditLog.deleteMany({ where: { companyId: id } });
  await prisma.company.deleteMany({ where: { id } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
}
