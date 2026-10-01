import { describe, expect, it } from "vitest";
import type { PasoConDecision } from "@/lib/cierre/evaluar";
import { decideObjective, stepSatisfied } from "./decision";

const step = (patch: Partial<PasoConDecision> = {}) => ({ clave: "banco", estadoCalculado: "bloquea", estado: "PENDIENTE", requiereConfirmacion: true, ...patch } as PasoConDecision);
const input = (patch: Partial<Parameters<typeof decideObjective>[0]> = {}) => ({ steps: [step()], paused: false, active: false,
  pendingApproval: false, openRequests: 0, hasRun: false, evidenceChanged: false, error: null, ...patch });

describe("evidence-driven ContaBot objectives", () => {
  it("never substitutes a previous approval for missing or changed evidence", () => {
    for (const state of ["bloquea", "sin_datos", "espera"] as const) expect(stepSatisfied(step({ estado: "CONFIRMADO", estadoCalculado: state }))).toBe(false);
    expect(stepSatisfied(step({ estado: "REVISAR", estadoCalculado: "listo" }))).toBe(false);
    expect(stepSatisfied(step({ estado: "CONFIRMADO", estadoCalculado: "listo" }))).toBe(true);
    expect(stepSatisfied(step({ estadoCalculado: "no_aplica" }))).toBe(true);
    expect(decideObjective(input({ steps: [] })).state).toBe("blocked");
  });
  it("stops paid repetition when the same evidence or a blocker remains", () => {
    expect(decideObjective(input()).runnable).toBe(true);
    expect(decideObjective(input({ hasRun: true })).runnable).toBe(false);
    expect(decideObjective(input({ hasRun: true, evidenceChanged: true })).runnable).toBe(true);
    expect(decideObjective(input({ hasRun: true, evidenceChanged: true, openRequests: 2 })).state).toBe("waiting_documents");
    expect(decideObjective(input({ pendingApproval: true, evidenceChanged: true })).state).toBe("waiting_approval");
    expect(decideObjective(input({ error: "Uncertain write", evidenceChanged: true })).state).toBe("blocked");
  });
  it("separates human review, dependency waits, and verified completion", () => {
    expect(decideObjective(input({ steps: [step({ estadoCalculado: "listo" })] })).state).toBe("ready_review");
    expect(decideObjective(input({ steps: [step({ estadoCalculado: "espera" })] })).state).toBe("waiting_dependency");
    expect(decideObjective(input({ steps: [step({ estadoCalculado: "listo", estado: "CONFIRMADO" })] })).state).toBe("completed");
    expect(decideObjective(input({ paused: true, active: true })).state).toBe("paused");
    expect(decideObjective(input({ active: true, evidenceChanged: true })).runnable).toBe(false);
  });
});
