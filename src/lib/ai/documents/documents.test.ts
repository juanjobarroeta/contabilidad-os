import { afterEach, describe, expect, it, vi } from "vitest";
import { documentCardFromResult, documentRefSchema } from "./contract";
import { signReview, verifyReview } from "./review-token";
import { documentFingerprint } from "@/lib/fiscal/document-fingerprint";
import { ejecutarPresentacion, sanearTarjetas } from "@/lib/copiloto/tarjetas";
import { managedTools, validateToolInput } from "@/lib/contabot/capabilities";

const ref = { kind: "prefactura" as const, companyId: "company-a", id: "draft-1" };
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
describe("Mochi document boundaries", () => {
  it("persists references rather than model-written amounts, URLs or statuses", () => {
    const card = documentCardFromResult("mostrar_documento", JSON.stringify({ documents: [ref], total: 999, url: "https://evil.invalid" }));
    expect(card).toEqual({ type: "documentos", documents: [ref] });
    expect(sanearTarjetas([card])).toEqual([card]);
    expect(documentCardFromResult("untrusted", JSON.stringify({ documents: [ref] }))).toBeNull();
    expect(documentCardFromResult("mostrar_documento", JSON.stringify({ documents: [{ ...ref, href: "/evil" }] }))).toBeNull();
    expect(ejecutarPresentacion("mostrar_tarjeta", { tipo: "documentos", documents: [ref] }).card).toBeNull();
  });
  it("requires identifiers or an explicit report period and bounds the card", () => {
    expect(documentRefSchema.safeParse({ kind: "balanza", companyId: "a" }).success).toBe(false);
    expect(documentRefSchema.safeParse({ kind: "factura", companyId: "a" }).success).toBe(false);
    expect(documentCardFromResult("buscar_documentos", JSON.stringify({ documents: Array(11).fill(ref) }))).toBeNull();
  });
  it("gives viewers document reads but never preparation or a stamp tool", async () => {
    const names = (writer: boolean) => managedTools(writer).flatMap((t) => t.type === "function" ? [t.name] : []);
    expect(names(false)).toEqual(expect.arrayContaining(["mostrar_documento", "buscar_documentos", "query_employees"]));
    expect(names(false)).not.toContain("preparar_nomina");
    expect(names(true)).toContain("preparar_prefactura");
    expect(names(true).some((n) => /timbrar|stamp/.test(n))).toBe(false);
    await expect(validateToolInput("mostrar_documento", { ...ref })).rejects.toThrow("INVALID_ARGUMENTS");
  });
  it("binds confirmation to the reviewer, conversation, company, document and expiry", () => {
    vi.stubEnv("AUTH_SECRET", "synthetic-documents-unit-secret");
    vi.useFakeTimers();
    const token = signReview({ ref, userId: "u", conversationId: "c", fingerprint: "a".repeat(64) });
    expect(verifyReview(token, ref, "u", "c").fingerprint).toBe("a".repeat(64));
    for (const args of [[{ ...ref, companyId: "b" }, "u", "c"], [{ ...ref, id: "other" }, "u", "c"], [ref, "other", "c"], [ref, "u", "other"]] as const) {
      expect(() => verifyReview(token, args[0], args[1], args[2])).toThrow();
    }
    expect(() => verifyReview(token + "x", ref, "u", "c")).toThrow();
    vi.advanceTimersByTime(11 * 60_000);
    expect(() => verifyReview(token, ref, "u", "c")).toThrow(/venció/);
  });
  it("fingerprints content independently of JSON key order but detects fiscal changes", () => {
    expect(documentFingerprint({ total: 116, taxes: { rate: 0.16, type: "IVA" } })).toBe(documentFingerprint({ taxes: { type: "IVA", rate: 0.16 }, total: 116 }));
    expect(documentFingerprint({ rate: 0.16 })).not.toBe(documentFingerprint({ rate: 0 }));
  });
});
