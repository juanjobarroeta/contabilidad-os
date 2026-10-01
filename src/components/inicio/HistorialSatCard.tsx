"use client";

// Mientras baja el historial del SAT (después del alta), Hoy lo dice: cuánto va
// y cuánto falta, en rango. Desaparece cuando termina. Es la continuación del
// chip y el anillo del alta, para quien ya siguió con su día.

import { useEffect, useState } from "react";
import { rangoHumano } from "@/lib/onboarding/historial";
import type { EstadoAlta } from "@/components/onboarding/tipos";
import { avanceHistorial } from "@/components/onboarding/tipos";

export function HistorialSatCard({ companyId }: { companyId: string }) {
  const [estado, setEstado] = useState<EstadoAlta | null>(null);

  useEffect(() => {
    let vivo = true;
    const leer = async () => {
      const r = await fetch(`/api/onboarding/estado?companyId=${encodeURIComponent(companyId)}&soloSiCargando=1`).catch(() => null);
      if (!vivo || !r?.ok) return;
      const j = await r.json();
      setEstado(j && "meses" in j ? (j as EstadoAlta) : null);
    };
    void leer();
    const t = setInterval(leer, 60_000);
    return () => {
      vivo = false;
      clearInterval(t);
    };
  }, [companyId]);

  if (!estado || estado.resumen.total === 0 || estado.resumen.completo) return null;
  const pct = Math.round(avanceHistorial(estado) * 100);
  const e = estado.estimacion;

  return (
    <div className="mb-4 rounded-2xl border border-cos-line bg-cos-card p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-cos-ink">Historial del SAT · {pct}%</p>
          <p className="mt-0.5 text-xs text-cos-ink-soft">
            {estado.resumen.ok} de {estado.resumen.total} meses descargados
            {e ? ` · ${e.reciente.listo ? "lo reciente ya está" : `lo reciente en ${rangoHumano(e.reciente)}`} · todo en ${rangoHumano(e.completo)}` : ""}
            {e?.frenadoPorSat ? " · el SAT pidió esperar" : ""}
          </p>
        </div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-cos-line-soft">
        <div className="h-full rounded-full bg-cos-brand transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
