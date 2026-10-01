export const CONTABOT_MODEL = "gpt-6-astra";
export const MAX_TOOL_CALLS = 32;
export const MAX_TURN_MS = 10 * 60_000;

/** Explicit rollout; an API key alone must never switch a company's runtime. */
export function managedContaBotEnabled(companyId: string): boolean {
  return process.env.CONTABOT_MANAGED_ENABLED === "1" &&
    (process.env.CONTABOT_MANAGED_COMPANY_IDS ?? "").split(",").map((id) => id.trim()).includes(companyId);
}

export function requireManagedConfig(): void {
  if (!process.env.OPENAI_API_KEY || !process.env.CONTABOT_OPENAI_WEBHOOK_SECRET) {
    throw new Error("ContaBot necesita la configuración del agente y de sus notificaciones.");
  }
}

export class ContaBotError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
