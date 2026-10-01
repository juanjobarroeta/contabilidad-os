import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { evidenceHash } from "@/lib/fiscal/deduction-review";
import { parseReviewScope, reviewWriteSchema } from "@/lib/fiscal/deduction-review-contract";

const base = { expectedRevision: 0, evidenceHash: "a".repeat(64), requestId: randomUUID(),
  reason: "Revisé el expediente del gasto y documenté mi criterio.", references: ["Papel de trabajo, folio 42"], acknowledged: true };
const review = () => ({ ...base, kind: "review", invoiceId: "invoice-1", source: "PUE_DOCUMENTADO", regimenCode: "612", decision: "DOCUMENTADA" });
const election = () => ({ ...base, kind: "election", regimenCode: "606", choice: "COMPROBADAS", effectiveFrom: "2026-01", effectiveTo: "2026-12" });
describe("FISC-002O review input and snapshot contracts", () => {
  it("accepts explicit documentary reviews and reported elections without an amount", () => {
    expect(reviewWriteSchema.safeParse(review()).success).toBe(true);
    expect(reviewWriteSchema.safeParse(election()).success).toBe(true);
  });
  it.each([
    { expectedRevision: -1 }, { expectedRevision: 0.5 }, { requestId: "not-a-uuid" },
    { evidenceHash: "stale" }, { reason: "ok" }, { reason: "a".repeat(2001) },
    { references: [] }, { references: ["same", "same"] }, { references: ["x".repeat(501)] },
    { references: Array.from({ length: 9 }, (_, i) => `reference ${i}`) },
    { acknowledged: false }, { acknowledged: undefined }, { decision: "APROBADA" },
    { source: "INGRESO" }, { reviewedById: "spoof" }, { deduccionAutorizadaCentavos: 100 },
  ])("rejects incomplete, forged or approval input %j", (patch) => {
    expect(reviewWriteSchema.safeParse({ ...review(), ...patch }).success).toBe(false);
  });
  it("allows reopening without inventing supporting evidence", () => {
    expect(reviewWriteSchema.safeParse({ ...review(), decision: "PENDIENTE", references: [] }).success).toBe(true);
  });
  it.each([{ regimenCode: "612" }, { choice: "DEFINITIVO" }, { effectiveFrom: "2026-13" }, { effectiveFrom: "2026-12", effectiveTo: "2026-01" }])("rejects invalid election %j", (patch) => {
    expect(reviewWriteSchema.safeParse({ ...election(), ...patch }).success).toBe(false);
  });
  it("does not change the evidence hash for object or set ordering", () => {
    expect(evidenceHash({ a: 1, b: [{ x: 2 }, { x: 1 }] })).toBe(evidenceHash({ b: [{ x: 1 }, { x: 2 }], a: 1 }));
    expect(evidenceHash({ companyId: "a", revision: 1 })).not.toBe(evidenceHash({ companyId: "b", revision: 1 }));
    expect(evidenceHash({ revision: 1 })).not.toBe(evidenceHash({ revision: 2 }));
  });
  it.each(["", "companyId=c&year=2026&month=13", "companyId=c&year=2026&month=1&page=0", "companyId=c&year=2026&month=1&page=1.5"])("rejects invalid read scope %s", (query) => {
    expect(parseReviewScope(new URLSearchParams(query))).toBeNull();
  });
});
