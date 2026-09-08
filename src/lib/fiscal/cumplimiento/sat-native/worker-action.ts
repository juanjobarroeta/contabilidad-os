export type SatNativePilotWorkerAction =
  | "DISABLED"
  | "PUBLIC_PREFLIGHT"
  | "FIRST_SIGNED_POST"
  | "INVALID";

/**
 * The worker is inert when the selector is absent or blank. Only exact,
 * case-sensitive action names can reach network-capable code.
 */
export function parseSatNativePilotWorkerAction(
  raw: string | undefined,
): SatNativePilotWorkerAction {
  if (raw === undefined || raw.trim() === "") return "DISABLED";
  const action = raw;
  if (action === "DISABLED") return action;
  if (action === "PUBLIC_PREFLIGHT") return action;
  if (action === "FIRST_SIGNED_POST") return action;
  return "INVALID";
}
