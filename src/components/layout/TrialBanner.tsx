import type { SubscriptionState } from "@/lib/subscription";

// `enforcement` = SUBSCRIPTION_ENFORCEMENT_ENABLED (lo pasa el layout). Con el
// gating apagado NO afirmamos "modo solo lectura" — nada lo aplica todavía;
// con el gating encendido las escrituras sí devuelven 402 y el texto es veraz.
export function TrialBanner({
  state,
  enforcement = false,
}: {
  state: SubscriptionState;
  enforcement?: boolean;
}) {
  if (state.status === "ACTIVE") return null;

  if (state.isTrialing && state.daysLeft !== null) {
    const urgent = state.daysLeft <= 3;
    return (
      <div
        className={`px-4 py-2 text-sm flex items-center justify-between border-b ${
          urgent
            ? "bg-orange-50 border-orange-200 text-orange-900"
            : "bg-blue-50 border-blue-200 text-blue-900"
        }`}
      >
        <span>
          Te {state.daysLeft === 1 ? "queda" : "quedan"} <strong>{state.daysLeft}</strong>{" "}
          {state.daysLeft === 1 ? "día" : "días"} de prueba
        </span>
        <a
          href="/configuracion/facturacion"
          className="font-medium underline hover:no-underline"
        >
          Activar suscripción
        </a>
      </div>
    );
  }

  if (state.isExpired) {
    return (
      <div className="px-4 py-2 text-sm flex items-center justify-between border-b bg-red-50 border-red-200 text-red-900">
        <span>
          {enforcement
            ? "Tu prueba terminó. La cuenta está en modo solo lectura hasta que actives una suscripción."
            : "Tu prueba terminó. Muy pronto habilitaremos la activación en línea; mientras tanto puedes seguir usando tu cuenta o contactarnos para activar tu suscripción."}
        </span>
        <a
          href="/configuracion/facturacion"
          className="font-medium underline hover:no-underline"
        >
          {enforcement ? "Activar ahora" : "Ver opciones"}
        </a>
      </div>
    );
  }

  if (state.status === "PAST_DUE") {
    return (
      <div className="px-4 py-2 text-sm flex items-center justify-between border-b bg-red-50 border-red-200 text-red-900">
        <span>Hay un problema con tu pago. Actualiza tu método de pago para evitar interrupciones.</span>
        <a
          href="/configuracion/facturacion"
          className="font-medium underline hover:no-underline"
        >
          Resolver
        </a>
      </div>
    );
  }

  return null;
}
