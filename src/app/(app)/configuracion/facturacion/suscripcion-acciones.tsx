"use client";

import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

// Acciones de suscripción (Checkout y Billing Portal de Stripe). Los montos no
// se muestran aquí: los define el objeto Price en Stripe y se ven al confirmar.
const PLANES = [
  { id: "BASICO", nombre: "Básico", blurb: "Sincronización SAT, consultas y declaraciones." },
  { id: "PROFESIONAL", nombre: "Profesional", blurb: "Todo lo de Básico + banco y WhatsApp.", destacado: true },
  { id: "DESPACHO", nombre: "Despacho", blurb: "Multiempresa para contadores, con revisión humana." },
] as const;

type PlanId = (typeof PLANES)[number]["id"];

export function SuscripcionAcciones({
  configurado,
  tieneCliente,
}: {
  /** ¿Stripe está configurado en el servidor? */
  configurado: boolean;
  /** ¿El usuario ya tiene cliente de Stripe (puede abrir el portal)? */
  tieneCliente: boolean;
}) {
  const [plan, setPlan] = useState<PlanId>("PROFESIONAL");
  const [cargando, setCargando] = useState<"checkout" | "portal" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!configurado) {
    return (
      <p className="text-sm text-cos-ink-soft">
        Los pagos en línea aún no están habilitados. Durante la prueba tienes acceso completo;
        cuando actives tu plan podrás contratarlo y administrarlo desde aquí.
      </p>
    );
  }

  async function ir(destino: "checkout" | "portal") {
    setCargando(destino);
    setError(null);
    try {
      const res = await fetch(`/api/billing/${destino}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: destino === "checkout" ? JSON.stringify({ plan }) : undefined,
      });
      const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (res.ok && data?.url) {
        window.location.href = data.url;
        return;
      }
      setError(data?.error ?? "No se pudo completar la operación. Intenta de nuevo.");
    } catch {
      setError("No se pudo completar la operación. Intenta de nuevo.");
    }
    setCargando(null);
  }

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        {PLANES.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPlan(p.id)}
            aria-pressed={plan === p.id}
            className={`text-left rounded-lg border p-3 transition-all ${
              plan === p.id
                ? "border-cos-brand bg-cos-brand-tint"
                : "border-cos-line bg-cos-card hover:border-cos-brand/40"
            }`}
          >
            <p className="font-semibold text-sm text-cos-ink">
              {p.nombre}
              {"destacado" in p && p.destacado && (
                <span className="ml-2 text-[10px] uppercase tracking-wide text-cos-brand-ink">
                  Recomendado
                </span>
              )}
            </p>
            <p className="text-xs text-cos-ink-soft mt-1">{p.blurb}</p>
          </button>
        ))}
      </div>

      <p className="text-xs text-cos-ink-faint mb-4">
        El precio y la moneda se muestran al confirmar el pago en Stripe.
      </p>

      {error && (
        <p className="text-sm text-red-600 mb-3" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => ir("checkout")}
          disabled={cargando !== null}
          className="inline-flex items-center gap-2 rounded-md bg-cos-brand text-white text-sm font-semibold px-4 py-2 hover:bg-cos-brand-deep disabled:opacity-50"
        >
          {cargando === "checkout" && <Loader2 className="h-4 w-4 animate-spin" />}
          Contratar plan
        </button>

        {tieneCliente && (
          <button
            type="button"
            onClick={() => ir("portal")}
            disabled={cargando !== null}
            className="inline-flex items-center gap-2 rounded-md border border-cos-line bg-cos-card text-sm font-semibold px-4 py-2 text-cos-ink hover:border-cos-brand/40 disabled:opacity-50"
          >
            {cargando === "portal" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ExternalLink className="h-4 w-4" />
            )}
            Administrar suscripción
          </button>
        )}
      </div>
    </div>
  );
}
