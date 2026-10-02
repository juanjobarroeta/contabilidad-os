// Disposable local UI acceptance. No PAC keys, calls, issuance or third-party delivery.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { encode } from "next-auth/jwt";
import { chromium } from "playwright";

const db = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://invalid/blocked");
const origin = new URL(process.env.DOCUMENT_SMOKE_ORIGIN ?? "http://127.0.0.1:3219");
assert(["localhost", "127.0.0.1"].includes(db.hostname) && /test/i.test(db.pathname), "Disposable local test DB required");
assert(["localhost", "127.0.0.1"].includes(origin.hostname) && origin.protocol === "http:", "Local origin required");
assert(process.env.AUTH_SECRET?.startsWith("mochi-documents-synthetic-"), "Synthetic auth secret required");
process.env.DATABASE_URL = db.href;
const prisma = new PrismaClient({ datasourceUrl: db.href });
const { createPayrollRun } = await import("../src/lib/nomina/payroll-run.ts");
const tag = `doc-browser-${randomUUID()}`;
const users = [`${tag}-owner`, `${tag}-viewer`];
const out = process.env.DOCUMENT_SMOKE_ARTIFACTS ?? "/tmp/cos-document-browser";
const errors = [];
let browser;
async function contextFor(index) {
  const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
  const token = await encode({ secret: process.env.AUTH_SECRET, salt: "authjs.session-token", maxAge: 3600, token: { sub: users[index], id: users[index], email: `${index}@documents.invalid`, name: "Synthetic documents reviewer" } });
  await context.addCookies([{ name: "authjs.session-token", value: token, url: origin.origin, httpOnly: true, sameSite: "Lax" }]);
  return context;
}
try {
  await mkdir(out, { recursive: true });
  await prisma.user.createMany({ data: users.map((id, index) => ({ id, email: `${tag}-${index}@documents.invalid`, name: "Synthetic document reviewer", esOperador: true })) });
  await prisma.legalAcceptance.createMany({ data: users.flatMap((userId) => ["TERMINOS", "AVISO_PRIVACIDAD"].map((documento) => ({ userId, documento, version: "2026-09-03", contexto: "synthetic-document-ui-test" }))) });
  const company = await prisma.company.create({ data: { id: tag, rfc: "DOC261001AA1", razonSocial: "MOCHI DOCUMENTS SYNTHETIC ONLY", regimenFiscal: "601", codigoPostal: "06600", registroPatronal: "Y1234567890", modules: { create: { modulo: "CONTABILIDAD", habilitado: true } }, members: { create: users.map((userId, index) => ({ userId, role: index ? "VIEWER" : "OWNER" })) } } });
  const customer = await prisma.customer.create({ data: { companyId: tag, razonSocial: "SYNTHETIC CUSTOMER", rfc: "SYC261001AA1", regimenFiscal: "601", codigoPostal: "06600" } });
  const identity = (r) => ({ id: r.id, rfc: r.rfc, razonSocial: r.razonSocial, regimenFiscal: r.regimenFiscal, codigoPostal: r.codigoPostal });
  const prefactura = await prisma.facturaBorrador.create({ data: { companyId: tag, customerId: customer.id, draftId: `synthetic-draft-${randomUUID()}`, total: 116, payload: { companyId: tag, customerId: customer.id, formaPago: "03", metodoPago: "PUE", usoCfdi: "G03", items: [{ quantity: 1, product: { description: "Synthetic consulting service", product_key: "84111506", unit_key: "E48", price: 100, tax_included: false, taxes: [{ type: "IVA", rate: 0.16, factor: "Tasa", withholding: false }] } }], reviewIdentity: { emisor: identity(company), receptor: identity(customer) } } } });
  const uuid = randomUUID().toUpperCase();
  const xml = `<?xml version="1.0" encoding="UTF-8"?><cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Fecha="2026-09-15T12:00:00" SubTotal="100" Moneda="MXN" Total="116" TipoDeComprobante="I" Exportacion="01" MetodoPago="PUE" FormaPago="03" LugarExpedicion="06600"><cfdi:Emisor Rfc="DOC261001AA1" Nombre="MOCHI DOCUMENTS SYNTHETIC ONLY" RegimenFiscal="601"/><cfdi:Receptor Rfc="SYC261001AA1" Nombre="SYNTHETIC CUSTOMER" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601" UsoCFDI="G03"/><cfdi:Conceptos><cfdi:Concepto ClaveProdServ="84111506" Cantidad="1" ClaveUnidad="E48" Descripcion="Synthetic archived invoice" ValorUnitario="100" Importe="100" ObjetoImp="02"/></cfdi:Conceptos><cfdi:Impuestos TotalImpuestosTrasladados="16"><cfdi:Traslados><cfdi:Traslado Base="100" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.160000" Importe="16"/></cfdi:Traslados></cfdi:Impuestos><cfdi:Complemento><tfd:TimbreFiscalDigital Version="1.1" UUID="${uuid}" FechaTimbrado="2026-09-15T12:00:00" RfcProvCertif="SYN010101AAA"/></cfdi:Complemento></cfdi:Comprobante>`;
  const invoice = await prisma.invoice.create({ data: { companyId: tag, customerId: customer.id, tipo: "INGRESO", tipoSat: "I", status: "STAMPED", uuid, fecha: new Date("2026-09-15T12:00:00Z"), formaPago: "03", metodoPago: "PUE", usoCfdi: "G03", subtotal: 100, total: 116, rawXml: xml } });
  const employee = await prisma.employee.create({ data: { companyId: tag, nombre: "Synthetic", apellidoPaterno: "Employee", rfc: "SYN010101AA12", curp: "SYN010101HDFXXX00", nss: "12345678901", codigoPostal: "06600", fechaIngreso: new Date("2025-01-01"), tipoContrato: "01", tipoJornada: "01", salarioDiario: 500, salarioDiarioIntegrado: 525, periodicidadPago: "04" } });
  const run = await createPayrollRun({ companyId: tag, tipo: "ORDINARIA", periodoInicio: new Date("2026-09-01T12:00:00Z"), periodoFin: new Date("2026-09-15T12:00:00Z"), fechaPago: new Date("2026-09-15T12:00:00Z"), diasPagados: 15, employeeIds: [employee.id] });
  assert(run.ok);
  const conversationId = `${tag}-chat`;
  await prisma.chatConversation.create({ data: { id: conversationId, companyId: tag, userId: users[0], visibility: "COMPANY", title: "Synthetic documents" } });
  const documents = [
    ...["balanza", "polizas", "catalogo", "iva", "isr", "retenciones"].map((kind) => ({ kind, companyId: tag, ...(kind === "catalogo" ? {} : { year: 2026, month: 9 }) })),
    { kind: "prefactura", companyId: tag, id: prefactura.id }, { kind: "factura", companyId: tag, id: invoice.id }, { kind: "nomina", companyId: tag, id: run.runId },
  ];
  await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: "Documentos sintéticos para revisar; no se emitirá ningún CFDI.", cards: documents.map((ref) => ({ type: "documentos", documents: [ref] })) } });
  browser = await chromium.launch({ headless: true });
  const context = await contextFor(0), page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${origin}/contabilidad/balanza?y=2026&m=9`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const nav = page.getByRole("navigation", { name: "Contabilidad", exact: true });
  for (const name of ["Pólizas", "Balanza", "Catálogo", "Estados financieros", "Cierre"]) await nav.getByRole("link", { name, exact: true }).waitFor();
  await page.evaluate(({ conversationId, companyId }) => window.dispatchEvent(new CustomEvent("cos:ask-ai", { detail: { conversationId, companyId } })), { conversationId, companyId: tag });
  await page.getByTestId("document-card").first().waitFor();
  const card = (name) => page.getByTestId("document-card").filter({ has: page.getByText(name, { exact: true }) });
  async function open(name) { await card(name).getByRole("button", { name: "Ver documento", exact: true }).click(); await page.getByRole("dialog").waitFor(); }
  const close = () => page.getByRole("button", { name: "Cerrar documento", exact: true }).click();
  await open("Balanza de comprobación");
  await page.getByRole("dialog").getByText(/no equivale a la presentada/).waitFor();
  await page.screenshot({ path: `${out}/balanza-desktop.png`, fullPage: true });
  await close();
  for (const name of ["Pólizas y libro diario", "Catálogo de cuentas", "Papel de IVA", "Papel de ISR", "Papel de retenciones"]) { await open(name); await close(); }
  await open("Prefactura — sin timbrar");
  await page.getByRole("button", { name: "Revisar para timbrar", exact: true }).click();
  const stamp = page.getByRole("button", { name: "Confirmar y timbrar", exact: true });
  await stamp.waitFor();
  assert(await stamp.isDisabled());
  await page.getByRole("checkbox", { name: /He revisado estos/ }).check();
  assert(await stamp.isEnabled());
  await page.screenshot({ path: `${out}/prefactura-review-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await stamp.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/prefactura-review-mobile.png`, fullPage: true });
  // Deliberately do not click: issuance is covered by mocked PAC integration tests.
  await close();
  await open("Nómina ordinaria");
  await page.getByRole("button", { name: "Ver recibo", exact: true }).click();
  await page.getByText("BORRADOR", { exact: true }).first().waitFor();
  await page.screenshot({ path: `${out}/payroll-preview-mobile.png`, fullPage: true });
  await page.getByRole("button", { name: "Cerrar representación", exact: true }).click();
  await close();
  await open("CFDI");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "XML", exact: true }).click();
  const download = await downloadEvent;
  assert(/xml/i.test(download.suggestedFilename()));
  await page.getByRole("button", { name: "Ver representación impresa", exact: true }).click();
  await page.getByText("Synthetic archived invoice", { exact: true }).waitFor();
  await page.screenshot({ path: `${out}/historical-cfdi-mobile.png`, fullPage: true });
  const viewer = await contextFor(1), viewerPage = await viewer.newPage();
  const read = await viewer.request.get(`${origin}/api/ai/documentos?companyId=${tag}&kind=prefactura&id=${prefactura.id}&conversationId=${conversationId}`);
  assert.equal((await read.json()).document.stampable, false);
  const denied = await viewer.request.post(`${origin}/api/ai/documentos`, { data: { action: "review", ref: documents[6], conversationId } });
  assert.equal(denied.status(), 403);
  await viewerPage.close();
  assert.equal(await prisma.invoice.count({ where: { companyId: tag } }), 1);
  assert.equal(await prisma.stagedAction.count({ where: { companyId: tag, type: "mochi_human_stamp" } }), 0);
  assert.deepEqual(errors, []);
  console.log(`PASS: visible accounting navigation, nine document cards, desktop/mobile review, historical XML download, payroll preview and viewer denial; no issuance. Screenshots: ${out}`);
} catch (e) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) { await page.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {}); console.error((await page.locator("body").innerText()).slice(-4000)); }
  throw e;
} finally {
  await browser?.close();
  await prisma.payrollRun.deleteMany({ where: { companyId: tag } });
  await prisma.facturaBorrador.deleteMany({ where: { companyId: tag } });
  await prisma.auditLog.deleteMany({ where: { companyId: tag } });
  await prisma.company.deleteMany({ where: { id: tag } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
  const { prisma: shared } = await import("../src/lib/prisma.ts");
  await shared.$disconnect();
}
