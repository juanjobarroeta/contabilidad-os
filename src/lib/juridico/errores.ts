// ─────────────────────────────────────────────────────────────────────────────
// Qué le decimos al abogado cuando un turno muere. El SDK de Anthropic lanza
// errores con el JSON crudo en inglés («Your credit balance is too low…»);
// eso no es un mensaje para un usuario. Aquí se traduce lo que sabemos
// explicar; lo desconocido sale tal cual (sirve para diagnosticar).
// ─────────────────────────────────────────────────────────────────────────────

export const MENSAJE_SIN_CREDITO = "El servicio de IA no está disponible: la cuenta de Anthropic se quedó sin crédito. Avisa al administrador; tu conversación y los borradores quedaron guardados.";
export const MENSAJE_SATURADO = "El servicio de IA está saturado en este momento. Espera un minuto y vuelve a intentar; lo que ya se escribió quedó guardado.";
export const MENSAJE_ACCESO_IA = "El servicio de IA rechazó la llave de acceso. Avisa al administrador.";

export function mensajeDeErrorParaAbogado(error: unknown): string {
  const crudo = error instanceof Error ? error.message : typeof error === "string" ? error : "Error interno";
  const texto = crudo.toLowerCase();
  if (texto.includes("credit balance")) return MENSAJE_SIN_CREDITO;
  if (/^(429|529)\b/.test(crudo) || texto.includes("rate_limit_error") || texto.includes("overloaded_error")) return MENSAJE_SATURADO;
  if (/^401\b/.test(crudo) || texto.includes("authentication_error") || texto.includes("invalid x-api-key")) return MENSAJE_ACCESO_IA;
  return crudo;
}
