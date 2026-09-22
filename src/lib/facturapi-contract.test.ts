import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFacturapiClient, ensureFacturapiCustomer, provisionFacturapiOrg } from "./facturapi";
import { readFacturapiFile } from "./facturapi-file";
import { parseFacturapiError } from "./facturapi-errors";
import { facturapiPacProvider } from "./pac/facturapi";
import type { CfdiInput } from "./pac/types";

const db = vi.hoisted(() => ({
  company: { findUnique: vi.fn(), update: vi.fn() },
  invoice: { findMany: vi.fn() },
  customer: { update: vi.fn() },
}));
vi.mock("./prisma", () => ({ prisma: db }));
vi.mock("./crypto", () => ({
  decryptSecret: (value: string) => value.replace(/^encrypted:/, ""),
  encryptSecret: (value: string) => `encrypted:${value}`,
}));

// Exercise the installed SDK, including its transport and binary/error parsing.
// Only fetch and local persistence are replaced. No real PAC request can escape.
const fetchMock = vi.fn<typeof fetch>();
const key = "encrypted:fixture-company-key";
const input: CfdiInput = {
  customerRef: "customer-fixture",
  paymentForm: "03",
  paymentMethod: "PUE",
  use: "G03",
  items: [{
    quantity: 1,
    product: {
      description: "Servicio de prueba",
      product_key: "84111506",
      price: 100,
      tax_included: false,
      taxes: [{ type: "IVA", factor: "Tasa", rate: 0.16 }],
    },
  }],
};

function reply(body: unknown, init?: ResponseInit) {
  fetchMock.mockResolvedValueOnce(Response.json(body, init));
}

function requestAt(index = 0) {
  const [url, options] = fetchMock.mock.calls[index];
  return { url: new URL(String(url)), options: options!, headers: new Headers(options?.headers) };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockRejectedValue(new Error("Unexpected PAC request in offline contract test"));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("FACTURAPI_MASTER_KEY", "fixture-master-key");
  db.invoice.findMany.mockResolvedValue([]);
  db.company.update.mockResolvedValue({});
  db.customer.update.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Facturapi SDK application contract", () => {
  it("preserves the CFDI payload and scopes authentication to the company", async () => {
    reply({ id: "invoice-fixture", uuid: "uuid-fixture", total: 116, folio_number: 12 });
    const result = await facturapiPacProvider.createCfdi(key, input);
    expect(result).toMatchObject({ ok: true, data: { pacId: "invoice-fixture", uuid: "uuid-fixture", total: 116 } });
    const { url, options, headers } = requestAt();
    expect(url.href).toBe("https://www.facturapi.io/v2/invoices");
    expect(options.method).toBe("POST");
    expect(headers.get("authorization")).toBe("Bearer fixture-company-key");
    expect(JSON.parse(String(options.body))).toEqual({
      customer: input.customerRef, payment_form: "03", payment_method: "PUE", use: "G03", items: input.items,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps draft creation, stamping and discard as distinct requests", async () => {
    reply({ id: "draft-fixture" });
    reply({ id: "draft-fixture", uuid: "uuid-fixture" });
    reply({ id: "discard-fixture", status: "canceled" });
    expect(await facturapiPacProvider.createDraft(key, input)).toEqual({ ok: true, data: { draftId: "draft-fixture" } });
    expect(JSON.parse(String(requestAt().options.body)).status).toBe("draft");
    await facturapiPacProvider.stampDraft(key, "draft-fixture");
    expect(requestAt(1).url.pathname).toBe("/v2/invoices/draft-fixture/stamp");
    expect(requestAt(1).options.method).toBe("POST");
    await facturapiPacProvider.discardDraft(key, "discard-fixture");
    expect(requestAt(2).url.pathname).toBe("/v2/invoices/discard-fixture");
    expect(requestAt(2).url.searchParams.get("motive")).toBe("03");
    expect(requestAt(2).options.method).toBe("DELETE");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("preserves cancellation motive/substitution and does not treat pending as cancelled", async () => {
    reply({ status: "valid", cancellation_status: "pending" });
    const result = await facturapiPacProvider.cancelCfdi(key, "invoice-fixture", "01", "replacement-uuid");
    expect(result).toMatchObject({ ok: true, data: { estado: "en_proceso" } });
    expect(requestAt().url.searchParams.get("motive")).toBe("01");
    expect(requestAt().url.searchParams.get("substitution")).toBe("replacement-uuid");
  });

  it.each([
    { type: "P", complements: [{ type: "pago", data: [{ payment_form: "03", date: "2026-08-15", related_documents: [{ uuid: "parent-uuid", amount: 58, installment: 1 }] }] }] },
    { type: "N", complements: [{ type: "nomina", data: { tipo_nomina: "O", fecha_pago: "2026-08-15", percepciones: { percepcion: [{ importe_gravado: 100 }] } } }] },
  ])("passes through the $type complement without changing fiscal amounts", async (payload) => {
    reply({ id: "invoice-fixture" });
    await getFacturapiClient(key).invoices.create(payload);
    expect(JSON.parse(String(requestAt().options.body))).toEqual(payload);
  });

  it("creates a customer in the company account and persists its PAC identifier", async () => {
    reply({ id: "customer-fixture" });
    const result = await ensureFacturapiCustomer(key, {
      id: "local-customer", facturapiId: null, razonSocial: "CLIENTE DE PRUEBA", rfc: "XAXX010101000",
      regimenFiscal: "616", email: null, phone: null, domicilio: null, codigoPostal: "06000",
    });
    expect(result).toEqual({ ok: true, facturapiId: "customer-fixture" });
    expect(requestAt().url.pathname).toBe("/v2/customers");
    expect(requestAt().headers.get("authorization")).toBe("Bearer fixture-company-key");
    expect(JSON.parse(String(requestAt().options.body))).toMatchObject({ tax_id: "XAXX010101000", address: { zip: "06000" } });
    expect(db.customer.update).toHaveBeenCalledWith({ where: { id: "local-customer" }, data: { facturapiId: "customer-fixture" } });
  });

  it("uploads the original CSD bytes as multipart data and persists the returned encrypted key", async () => {
    const certificate = Buffer.from("fixture certificate bytes");
    const privateKey = Buffer.from("fixture private key bytes");
    db.company.findUnique.mockResolvedValue({
      id: "company-fixture", rfc: "XAXX010101000", razonSocial: "EMPRESA DE PRUEBA", nombreComercial: null,
      regimenFiscal: "601", codigoPostal: "06000", domicilioFiscal: null, facturapiOrgId: null, facturapiApiKey: null,
      csdCer: `encrypted:${certificate.toString("base64")}`, csdKey: `encrypted:${privateKey.toString("base64")}`,
      csdPassword: "encrypted:fixture-password",
    });
    reply({ id: "org-fixture" });
    reply({ id: "org-fixture" });
    reply({ id: "org-fixture" });
    reply("fixture-live-key");
    expect(await provisionFacturapiOrg("company-fixture")).toMatchObject({ ok: true, orgId: "org-fixture", csdUploaded: true, hasLiveKey: true });
    expect(requestAt(1).url.pathname).toBe("/v2/organizations/org-fixture/legal");
    const upload = requestAt(2);
    expect(upload.url.pathname).toBe("/v2/organizations/org-fixture/certificate");
    expect(upload.options.method).toBe("PUT");
    const wireRequest = new Request(upload.url, upload.options);
    expect(wireRequest.headers.get("content-type")).toContain("multipart/form-data; boundary=");
    const form = await wireRequest.formData();
    expect(Buffer.from(await (form.get("cer") as Blob).arrayBuffer())).toEqual(certificate);
    expect(Buffer.from(await (form.get("key") as Blob).arrayBuffer())).toEqual(privateKey);
    expect(form.get("password")).toBe("fixture-password");
    expect(requestAt(3).url.pathname).toBe("/v2/organizations/org-fixture/apikeys/live");
    for (let i = 0; i < 4; i++) expect(requestAt(i).headers.get("authorization")).toBe("Bearer fixture-master-key");
    expect(db.company.update).toHaveBeenCalledWith({
      where: { id: "company-fixture" }, data: { facturapiOrgId: "org-fixture", facturapiApiKey: "encrypted:fixture-live-key" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each(["downloadPdf", "downloadXml"] as const)("preserves binary bytes from %s", async (method) => {
    const bytes = Buffer.from([0, 37, 80, 68, 70, 255, 128, 10]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { "Content-Type": method === "downloadPdf" ? "application/pdf" : "application/xml" } }));
    const file = await getFacturapiClient(key).invoices[method]("invoice-fixture");
    expect(await readFacturapiFile(file)).toEqual(bytes);
  });

  it("supports the SDK's Blob download fallback", async () => {
    expect(await readFacturapiFile(new Blob(["fixture PDF"]))).toEqual(Buffer.from("fixture PDF"));
  });

  it("rejects failed binary streams instead of returning a partial file", async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error("interrupted download")); } });
    fetchMock.mockResolvedValueOnce(new Response(body, { headers: { "Content-Type": "application/pdf" } }));
    const file = await getFacturapiClient(key).invoices.downloadPdf("invoice-fixture");
    await expect(readFacturapiFile(file)).rejects.toThrow("interrupted download");
  });

  it.each([
    [401, "auth", 422], [403, "auth", 422], [400, "validation", 422], [422, "validation", 422],
    [404, "not_found", 422], [429, "rate_limit", 429], [500, "server", 502], [503, "server", 502],
  ] as const)("normalizes SDK HTTP %i errors without retrying an issuance", async (status, kind, expectedStatus) => {
    reply({ message: "fixture API rejection" }, { status });
    const result = await facturapiPacProvider.createCfdi(key, input);
    expect(result).toMatchObject({ ok: false, kind, status: expectedStatus, needsReconfigure: kind === "auth" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves structured validation diagnostics and correlation without forwarding headers", async () => {
    const errors = [{ code: "invalid", path: "customer.tax_id", message: "RFC inválido" }];
    reply({ message: "Datos inválidos", code: "validation", path: "customer", location: "body", errors }, {
      status: 422, headers: { "x-facturapi-log-id": "fixture-log", "set-cookie": "fixture-private-header" },
    });
    const error = await getFacturapiClient(key).customers.create({}).catch((e: unknown) => e);
    const normalized = parseFacturapiError(error);
    expect(normalized).toMatchObject({ kind: "validation", status: 422, details: { code: "validation", errors, logId: "fixture-log" } });
    expect(JSON.stringify(normalized)).not.toContain("fixture-private-header");
    expect(parseFacturapiError({ response: { status: 429, data: { message: "legacy response" } } })).toMatchObject({ kind: "rate_limit", rawMessage: "legacy response" });
  });
});
