// ─────────────────────────────────────────────────────────────────────────────
// Suspensión de servicio por falta de pago. La decisión es PURA (testeable sin
// DB); la resolución por usuario carga el estado vía import dinámico para no
// arrastrar prisma al grafo estático (y poder testear la lógica pura aislada).
//   - Kill-switch BILLING_SUSPENSION_ENABLED (default OFF): apagado = nadie se
//     suspende, aunque su suscripción no esté activa. Despliega sin tumbar a
//     nadie hasta que el cobro automático (Stripe) esté listo.
//   - El operador de plataforma NUNCA se suspende (override).
//   - "Override manual" de un cliente que pagó por transferencia = poner su
//     subscriptionStatus = ACTIVE (no hace falta otro campo).
// ─────────────────────────────────────────────────────────────────────────────

export function suspensionHabilitada(): boolean {
  return process.env.BILLING_SUSPENSION_ENABLED === "true";
}

/** Decisión pura: ¿se suspende el acceso? */
export function debeSuspender(opts: {
  suscripcionActiva: boolean;
  esOperador: boolean;
  habilitado: boolean;
}): boolean {
  if (!opts.habilitado) return false;
  if (opts.esOperador) return false;
  return !opts.suscripcionActiva;
}

/** Resuelve la suspensión de un usuario (estado + operador + kill-switch). */
export async function accesoSuspendido(userId: string): Promise<boolean> {
  if (!suspensionHabilitada()) return false;
  const [{ getUserSubscriptionState }, { isOperador }] = await Promise.all([
    import("@/lib/subscription"),
    import("@/lib/authz"),
  ]);
  const [state, operador] = await Promise.all([getUserSubscriptionState(userId), isOperador(userId)]);
  return debeSuspender({ suscripcionActiva: state.isActive, esOperador: operador, habilitado: true });
}
