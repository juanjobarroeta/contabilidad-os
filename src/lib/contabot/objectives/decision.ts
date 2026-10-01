import type { PasoConDecision } from "@/lib/cierre/evaluar";

export const OBJECTIVE_LABELS = {
  queued: "Por revisar", running: "Trabajando", verifying: "Verificando evidencia",
  waiting_documents: "Espera documentos", waiting_approval: "Necesita tu decisión",
  waiting_dependency: "Espera otro paso", ready_review: "Listo para tu revisión",
  blocked: "Requiere atención", completed: "Checklist verificado", paused: "Pausado",
} as const;
export type ObjectiveState = keyof typeof OBJECTIVE_LABELS;

export function stepSatisfied(step: PasoConDecision): boolean {
  if (step.estadoCalculado === "no_aplica") return true;
  if (["bloquea", "espera", "sin_datos"].includes(step.estadoCalculado)) return false;
  if (step.requiereConfirmacion) return ["CONFIRMADO", "OMITIDO"].includes(step.estado);
  return step.estadoCalculado === "listo";
}

/** A model response can never satisfy a check or supply missing evidence. */
export function decideObjective(input: {
  steps: PasoConDecision[]; paused: boolean; active: boolean; pendingApproval: boolean;
  openRequests: number; hasRun: boolean; evidenceChanged: boolean; error: string | null;
}): { state: ObjectiveState; nextAction: string; runnable: boolean } {
  const result = (state: ObjectiveState, nextAction: string, runnable = false) => ({ state, nextAction, runnable });
  if (input.paused) return result("paused", "Reanuda el objetivo cuando quieras continuar.");
  if (input.active) return result("running", "ContaBot está revisando la evidencia. Puedes cerrar esta página.");
  if (input.error) return result("blocked", input.error);
  if (input.pendingApproval) return result("waiting_approval", "Abre la conversación para revisar la propuesta pendiente.");
  if (input.openRequests && input.hasRun) return result("waiting_documents", `${input.openRequests} solicitud(es) pendiente(s). Se revisará al recibir los documentos.`);
  if (!input.steps.length) return result("blocked", "No se pudo verificar el checklist del periodo.");
  if (input.steps.every(stepSatisfied)) return result("completed", "Los controles actuales y las decisiones requeridas están verificados. Consulta la evidencia del cierre.");
  const remaining = input.steps.filter((step) => !stepSatisfied(step));
  if (remaining.every((step) => step.estadoCalculado === "espera")) return result("waiting_dependency", "Resuelve primero las dependencias indicadas en el cierre.");
  if (remaining.every((step) => step.estadoCalculado === "listo")) return result("ready_review", "Confirma los pasos en Cierre después de revisar su evidencia.");
  if (!input.hasRun || input.evidenceChanged) return result("queued", "Investigar los controles pendientes y preparar el siguiente paso.", true);
  return result("blocked", "Revisa el último informe. No hay evidencia nueva para otra revisión automática.");
}
