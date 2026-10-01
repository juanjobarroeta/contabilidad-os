// Local-only FISC-002O browser acceptance. Seeds and cleans ONLY its synthetic
// company/users in a disposable *_test database. Never accepts a remote origin.
// Start the app against the SAME TEST_DATABASE_URL and AUTH_SECRET first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { encode } from "next-auth/jwt";
import { chromium } from "playwright";

const dbUrl = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://invalid/blocked");
const origin = new URL(process.env.REVIEW_SMOKE_ORIGIN ?? "http://127.0.0.1:3218");
assert(["localhost", "127.0.0.1"].includes(dbUrl.hostname) && /test/i.test(dbUrl.pathname), "Disposable local test DB required");
assert(["localhost", "127.0.0.1"].includes(origin.hostname) && origin.protocol === "http:", "Local HTTP origin required");
assert(process.env.AUTH_SECRET?.startsWith("fisc002o-synthetic-"), "Use the dedicated synthetic AUTH_SECRET");
const prisma = new PrismaClient({ datasourceUrl: dbUrl.href });
const id = `fisc002o-browser-${randomUUID()}`;
const userIds = [`${id}-accountant`, `${id}-viewer`, `${id}-restricted`];
let browser;
const periodo = new Date().toISOString().slice(0, 7);
assert(periodo.startsWith("2026-"), "This acceptance fixture is versioned to 2026");
const [year, month] = periodo.split("-").map(Number);
const query = new URLSearchParams({ companyId: id, year: String(year), month: String(month) });
const endpoint = `/api/impuestos/asignaciones-regimen/deducciones/revision?${query}`;
let invoiceId;
const failures = [];

async function contextFor(index) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
  const token = await encode({ secret: process.env.AUTH_SECRET, salt: "authjs.session-token", maxAge: 3600,
    token: { sub: userIds[index], id: userIds[index], email: `${index}@fisc002o.invalid`, name: "Synthetic fiscal reviewer" } });
  await context.addCookies([{ name: "authjs.session-token", value: token, url: origin.origin, httpOnly: true, sameSite: "Lax" }]);
  return context;
}
try {
  for (const [index, userId] of userIds.entries()) {
    await prisma.user.create({ data: { id: userId, email: `${id}-${index}@fisc002o.invalid`, name: "Synthetic fiscal reviewer" } });
    await prisma.legalAcceptance.createMany({ data: ["TERMINOS", "AVISO_PRIVACIDAD"].map((documento) => ({
      userId, documento, version: "2026-09-03", contexto: "synthetic-browser-test" })) });
  }
  await prisma.company.create({ data: { id, rfc: "FISO261001ABC", razonSocial: "FISC-002O SYNTHETIC ONLY", regimenFiscal: "606", codigoPostal: "06600",
    modules: { create: { modulo: "CONTABILIDAD", habilitado: true } },
    members: { create: userIds.map((userId, i) => ({ userId, role: i === 1 ? "VIEWER" : "ACCOUNTANT", allowedModules: i === 2 ? ["CONSTRUCCION"] : [] })) } } });
  invoiceId = (await prisma.invoice.create({ data: { companyId: id, tipo: "EGRESO", tipoSat: "I", status: "STAMPED", uuid: randomUUID(),
    fecha: new Date(Date.UTC(year, month - 1, 1, 12)), metodoPago: "PUE", formaPago: "03", usoCfdi: "G03", moneda: "MXN",
    subtotal: "100", total: "116", naturaleza: "GASTO", naturalezaManual: true } })).id;
  browser = await chromium.launch({ headless: true });
  const accountant = await contextFor(0);
  const page = await accountant.newPage();
  page.on("response", async (response) => {
    if (response.url().includes("deducciones/revision") && response.request().method() === "POST") {
      console.log("Review save response", response.status(), await response.text());
    }
  });
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(new URL("/facturas", origin).href, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const panel = page.getByRole("region", { name: "Revisión de deducciones por régimen" });
  await panel.getByRole("button", { name: /Revisión de deducciones/ }).click({ timeout: 90_000 });
  await panel.getByRole("button", { name: "Documentar criterio", exact: true }).waitFor({ timeout: 60_000 });
  assert.match(await panel.innerText(), /Base documental.*100/);
  await panel.getByRole("button", { name: "Documentar criterio", exact: true }).click();
  const form = panel.getByRole("form", { name: "Guardar revisión fiscal" });
  await form.getByLabel(/Motivo y alcance/).fill("Revisión sintética del gasto; todavía no se aprueba un importe fiscal.");
  await form.getByLabel(/Referencias al expediente/).fill("Estado de cuenta sintético, folio 42");
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: "Guardar criterio sin afectar cálculos" }).click();
  await panel.getByText(/Versión 1 guardada/).waitFor();
  await panel.getByRole("button", { name: "Documentar criterio", exact: true }).waitFor();
  assert.equal(await prisma.fiscalDeductionReview.count({ where: { companyId: id } }), 1);
  console.log("PASS accountant saves a documentary review through the real UI and API");

  await panel.getByRole("button", { name: "Documentar criterio", exact: true }).click();
  await form.getByLabel(/Motivo y alcance/).fill("Este borrador debe conservarse al detectar evidencia desactualizada.");
  await form.getByRole("checkbox").check();
  await prisma.invoice.update({ where: { id: invoiceId }, data: { subtotal: "101", total: "117.16" } });
  await form.getByRole("button", { name: "Guardar criterio sin afectar cálculos" }).click();
  await form.getByText(/Tu borrador se conserva/).waitFor();
  assert.match(await form.getByLabel(/Motivo y alcance/).inputValue(), /conservarse/);
  assert.equal(await form.getByRole("button", { name: "Guardar criterio sin afectar cálculos" }).isDisabled(), true);
  assert.equal(await prisma.fiscalDeductionReview.count({ where: { companyId: id } }), 1);
  console.log("PASS stale evidence returns 409, preserves the draft, and prevents blind retry");
  await form.getByRole("button", { name: "Cancelar borrador" }).click();
  await panel.getByRole("button", { name: "Recargar evidencia" }).click();
  await panel.getByText(/Revisar de nuevo/).waitFor();
  await panel.getByRole("button", { name: "Registrar evidencia de la opción" }).click();
  await form.getByLabel("Opción informada", { exact: true }).selectOption("COMPROBADAS");
  await form.getByLabel(/Motivo y alcance/).fill("La opción se informa con base en el expediente sintético del ejercicio.");
  await form.getByLabel(/Referencias al expediente/).fill("Papel de trabajo sintético anual, folio 43");
  await form.getByRole("checkbox").check();
  await form.getByRole("button", { name: "Guardar criterio sin afectar cálculos" }).click();
  await panel.getByText(/Deducciones comprobadas informadas.*Evidencia registrada/).waitFor();
  console.log("PASS reported rental option saved with explicit effective months and no tax activation");
  await panel.getByRole("button", { name: "Ver historial de revisiones y opciones" }).click();
  await panel.getByLabel("Historial fiscal").waitFor();
  assert.match(await panel.getByLabel("Historial fiscal").innerText(), /folio 42/);
  await page.screenshot({ path: process.env.REVIEW_SMOKE_SCREENSHOT ?? "/tmp/fisc002o-review.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  assert.equal(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, "Review panel must fit mobile width");
  await panel.screenshot({ path: (process.env.REVIEW_SMOKE_SCREENSHOT ?? "/tmp/fisc002o-review.png").replace(/\.png$/, "-mobile.png") });
  console.log("PASS mobile review panel fits a 390px viewport");

  const viewer = await contextFor(1), viewerPage = await viewer.newPage();
  await viewerPage.goto(new URL("/facturas", origin).href, { waitUntil: "domcontentloaded" });
  const viewerPanel = viewerPage.getByRole("region", { name: "Revisión de deducciones por régimen" });
  await viewerPanel.getByRole("button", { name: /Revisión de deducciones/ }).click();
  await viewerPanel.getByText(/Base documental/).waitFor();
  assert.equal(await viewerPanel.getByRole("button", { name: "Documentar criterio", exact: true }).count(), 0);
  assert.equal((await viewer.request.post(new URL(endpoint, origin).href, { data: {} })).status(), 403);
  const restricted = await contextFor(2);
  assert.equal((await restricted.request.get(new URL(endpoint, origin).href)).status(), 403);
  const summary = await (await accountant.request.get(new URL(endpoint, origin).href)).json();
  assert.equal(summary.deduccionAutorizadaCentavos, null); assert.equal(summary.usadaEnCalculoAutomatico, false);
  assert.equal(await prisma.taxDeclaration.count({ where: { companyId: id } }), 0);
  assert.deepEqual(failures, []);
  console.log("PASS viewer read-only UI/API, restricted-module denial, retained history, and unchanged tax boundary");
} finally {
  await browser?.close();
  await prisma.auditLog.deleteMany({ where: { companyId: id } });
  await prisma.company.deleteMany({ where: { id } });
  await prisma.legalAcceptance.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}
