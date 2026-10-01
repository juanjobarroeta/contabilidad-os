import { z } from "zod";

export const DEDUCTION_WORKFLOW_VERSION = "2026-10-01.1";
export const REVIEW_DECISIONS = {
  DOCUMENTADA: "Revisión documentada (sin aprobar importe)",
  NO_PROPONER: "No proponer como deducción de ISR",
  PENDIENTE: "Reabrir revisión",
} as const;
export const ELECTION_CHOICES = {
  "606": { COMPROBADAS: "Deducciones comprobadas informadas", OPCIONAL_35: "Opción del 35% informada", PENDIENTE: "Pendiente de confirmar" },
  "625": { PROVISIONAL: "Pagos provisionales informados", DEFINITIVO: "Pagos definitivos informados", PENDIENTE: "Pendiente de confirmar" },
} as const;
const reference = z.string().trim().min(3).max(500);
const base = {
  expectedRevision: z.number().int().min(0).max(1_000_000),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  requestId: z.string().uuid(),
  reason: z.string().trim().min(20).max(2000),
  references: z.array(reference).max(8).refine((refs) => new Set(refs).size === refs.length, "No repitas referencias."),
  acknowledged: z.literal(true),
};
export const reviewWriteSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("review"), invoiceId: z.string().min(1).max(100),
    source: z.enum(["PUE_DOCUMENTADO", "PPD_REP"]), regimenCode: z.string().regex(/^\d{3}$/),
    decision: z.enum(["DOCUMENTADA", "NO_PROPONER", "PENDIENTE"]) }).strict(),
  z.object({ ...base, kind: z.literal("election"), regimenCode: z.enum(["606", "625"]),
    choice: z.enum(["COMPROBADAS", "OPCIONAL_35", "PROVISIONAL", "DEFINITIVO", "PENDIENTE"]),
    effectiveFrom: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    effectiveTo: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).strict(),
]).superRefine((value, ctx) => {
  const pending = value.kind === "review" ? value.decision === "PENDIENTE" : value.choice === "PENDIENTE";
  if (!pending && value.references.length === 0) ctx.addIssue({ code: "custom", message: "Incluye al menos una referencia al expediente." });
  if (value.kind === "election") {
    if (!(value.choice in ELECTION_CHOICES[value.regimenCode])) ctx.addIssue({ code: "custom", message: "Opción incompatible con el régimen." });
    if (value.effectiveFrom > value.effectiveTo) ctx.addIssue({ code: "custom", message: "La vigencia no puede estar invertida." });
  }
});
export type ReviewWrite = z.infer<typeof reviewWriteSchema>;
export type ReviewTarget = { invoiceId: string; source: string; regimenCode: string };
export const reviewKey = (row: ReviewTarget) => JSON.stringify([row.invoiceId, row.source, row.regimenCode]);

export function parseReviewScope(params: URLSearchParams) {
  const companyId = params.get("companyId")?.trim() ?? "";
  const year = Number(params.get("year")), month = Number(params.get("month"));
  const page = Number(params.get("page") ?? "1");
  if (!companyId || companyId.length > 100 || !Number.isInteger(year) || year < 2000 || year > 2100
    || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(page) || page < 1 || page > 10_000) return null;
  return { companyId, year, month, page, periodo: `${year}-${String(month).padStart(2, "0")}` };
}
export type ReviewScope = NonNullable<ReturnType<typeof parseReviewScope>>;
