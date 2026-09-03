"use client";

import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import type { UsoIAEmpresa } from "@/lib/ai/uso";

// Sección «Uso de inteligencia artificial este mes»: barra por empresa (gasto
// vs techo del plan + extra) y botón para ampliar el límite (pago único en
// Stripe). Los montos se muestran en USD porque así se mide el costo del
// modelo; el precio del paquete lo define el Price en Stripe.
export function UsoIA({
  empresas,
  configurado,
  paqueteUsd,
}: {
  empresas: UsoIAEmpresa[];
  /** ¿Stripe + STRIPE_PRICE_IA_EXTRA configurados? */
  configurado: boolean;
  paqueteUsd: number;
}) {
  const [cargando, setCargando] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (empresas.length === 0) return null;

  async function ampliar(companyId: string) {
    setCargando(companyId);
    setError(null);
    try {
      const res = await fetch("/api/billing/ia-extra", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId }),
      });
      const data = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
      if (res.ok && data?.url) {
        window.location.href = data.url;
        return;
      }
      setError(data?.error ?? "No se pudo iniciar el pago.");
    } catch {
      setError("No se pudo iniciar el pago.");
    } finally {
      setCargando(null);
    }
  }

  return (
    <div className="bg-cos-card border border-cos-line rounded-xl p-6 mt-6">
      <div className="flex items-start gap-4">
        <div className="h-10 w-10 rounded-lg bg-cos-brand-tint text-cos-brand-ink flex items-center justify-center shrink-0">
          <Sparkles className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs uppercase text-cos-ink-soft tracking-wide">Inteligencia artificial</p>
          <p className="text-xl font-bold mt-1">Uso de este mes</p>
          <p className="text-sm text-cos-ink-soft mt-1">
            Cada empresa tiene un límite mensual de uso del asistente y de lectura de documentos según su plan.
            Al alcanzarlo, esas funciones se pausan hasta el siguiente mes o hasta ampliar el límite.
          </p>
        </div>
      </div>

      <ul className="mt-5 space-y-3">
        {empresas.map((e) => {
          const pct = e.topeMesUsd > 0 ? Math.min(100, Math.round((e.gastoMesUsd / e.topeMesUsd) * 100)) : 100;
          const agotado = e.gastoMesUsd >= e.topeMesUsd;
          return (
            <li key={e.companyId} className="rounded-lg border border-cos-line px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-cos-ink truncate">{e.razonSocial}</p>
                  <p className="text-xs text-cos-ink-faint font-mono">{e.rfc}</p>
                </div>
                <p className={`text-sm font-medium ${agotado ? "text-cos-red-ink" : "text-cos-ink-soft"}`}>
                  {e.gastoMesUsd.toFixed(2)} / {e.topeMesUsd.toFixed(2)} USD
                  {e.extraMesUsd > 0 && (
                    <span className="ml-1 text-xs text-cos-ink-faint">(incluye +{e.extraMesUsd.toFixed(0)} extra)</span>
                  )}
                  {e.duenoEnPrueba && <span className="ml-1 text-xs text-cos-ink-faint">· prueba</span>}
                </p>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-cos-paper">
                <div
                  className={`h-full rounded-full ${agotado ? "bg-cos-red-ink" : pct >= 80 ? "bg-cos-amber-ink" : "bg-cos-brand"}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {e.puedeAmpliar && (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-xs text-cos-ink-faint">
                    Ampliar suma {paqueteUsd} USD de uso al límite de este mes.
                  </p>
                  <button
                    type="button"
                    onClick={() => ampliar(e.companyId)}
                    disabled={!configurado || cargando !== null}
                    title={configurado ? undefined : "La compra en línea aún no está habilitada"}
                    className="inline-flex items-center gap-1.5 rounded-md border border-cos-line px-3 py-1.5 text-xs font-medium text-cos-brand-ink hover:bg-cos-brand-tint disabled:opacity-50"
                  >
                    {cargando === e.companyId && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    Ampliar límite
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="mt-3 text-sm text-cos-red-ink">{error}</p>}
      {!configurado && (
        <p className="mt-3 text-xs text-cos-ink-faint">
          La compra de uso extra aún no está habilitada en línea. Si lo necesitas, escríbenos y lo ampliamos.
        </p>
      )}
    </div>
  );
}
