"use client";

// ─────────────────────────────────────────────────────────────────────────────
// «HOY» — lo que el copiloto propone hacer hoy en todos los RFCs con cierre
// guiado: una fila por paso pendiente (ranqueada por el servidor) con UNA
// acción, y el avance de cada cierre abierto. Lee /api/cierre/hoy, que sólo
// consulta lo que el pase diario persistió (sin motores en abanico).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, ClipboardCheck } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Alert, Loading, RetryButton } from "@/components/ui/feedback";
import { cn } from "@/lib/utils";
import type { FilaHoy, ResumenEmpresaHoy } from "@/lib/cierre/hoy";

interface HoyResponse {
  filas: FilaHoy[];
  empresas: ResumenEmpresaHoy[];
}

const TONO: Record<string, string> = {
  bloquea: "bg-cos-red",
  REVISAR: "bg-cos-amber",
  atencion: "bg-cos-amber",
};

function etiquetaEstado(f: FilaHoy): { texto: string; clase: string } {
  if (f.paso === "declaracion" && f.diasRestantes != null && f.diasRestantes < 0) {
    return { texto: `venció hace ${Math.abs(f.diasRestantes)} d`, clase: "font-semibold text-cos-red-ink" };
  }
  if (f.estadoCalculado === "bloquea") return { texto: "bloquea el cierre", clase: "font-semibold text-cos-red-ink" };
  if (f.estado === "REVISAR") return { texto: "cambió: revisar", clase: "font-semibold text-cos-amber-ink" };
  if (f.paso === "declaracion" && f.diasRestantes != null) {
    return { texto: f.diasRestantes === 0 ? "vence hoy" : `vence en ${f.diasRestantes} d`, clase: "text-cos-amber-ink" };
  }
  return { texto: "atención", clase: "text-cos-ink-soft" };
}

export function HoyPendientes() {
  const router = useRouter();
  const { companies, setActiveCompany } = useCompany();
  const [data, setData] = useState<HoyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/cierre/hoy");
      const j = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(j?.filas)) throw new Error(j?.error ?? `HTTP ${res.status}`);
      setData(j as HoyResponse);
    } catch {
      setData(null);
      setError("No se pudo cargar lo de hoy.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  function irA(companyId: string, href: string) {
    const empresa = companies.find((c) => c.id === companyId);
    if (empresa) setActiveCompany(empresa);
    router.push(href);
  }

  if (error) {
    return (
      <Alert tone="danger" action={<RetryButton onClick={cargar} />}>
        {error}
      </Alert>
    );
  }
  if (loading || !data) return <Loading label="Revisando el cierre de tus empresas…" />;

  const bloquean = data.filas.filter((f) => f.estadoCalculado === "bloquea").length;
  const revisar = data.filas.filter((f) => f.estado === "REVISAR").length;

  return (
    <div className="space-y-5">
      <div className="rounded-card border border-cos-line bg-cos-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cos-line px-4 py-3">
          <p className="text-[14px] font-semibold text-cos-ink">
            Lo de hoy <span className="text-cos-ink-faint">{data.filas.length}</span>
          </p>
          <p className="text-[12px] text-cos-ink-soft">
            {bloquean > 0 && <span className="text-cos-red-ink">{bloquean} bloquea{bloquean === 1 ? "" : "n"}</span>}
            {bloquean > 0 && revisar > 0 && " · "}
            {revisar > 0 && <span className="text-cos-amber-ink">{revisar} por revisar</span>}
          </p>
        </div>
        {data.filas.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13.5px] text-cos-jade-ink">
            {data.empresas.length === 0
              ? "El copiloto aún no ha revisado el cierre: el pase diario corre cada mañana."
              : "Nada pendiente hoy — los cierres van al corriente."}
          </p>
        ) : (
          <ul className="divide-y divide-cos-line-soft">
            {data.filas.map((f) => {
              const et = etiquetaEstado(f);
              return (
                <li key={`${f.companyId}-${f.year}-${f.month}-${f.paso}`} className="flex items-center gap-3 px-4 py-3">
                  <span className={cn("w-1 self-stretch rounded-full", TONO[f.estado === "REVISAR" ? "REVISAR" : f.estadoCalculado] ?? "bg-cos-line")} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[13.5px] font-semibold text-cos-ink">
                      <span className="truncate">{f.empresa}</span>
                      <span className="rounded-full bg-cos-slate-tint px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-wide text-cos-ink-soft">
                        {f.tituloPaso}
                      </span>
                      <span className="hidden font-mono text-[10.5px] text-cos-ink-faint sm:inline">{f.periodoLabel}</span>
                    </p>
                    <p className="truncate text-[12.5px] text-cos-ink-soft">{f.detalle ?? "Revisar"}</p>
                  </div>
                  <span className={cn("hidden w-28 text-right text-[12px] md:block", et.clase)}>{et.texto}</span>
                  <button
                    type="button"
                    onClick={() => irA(f.companyId, f.href)}
                    className="shrink-0 rounded-control border border-cos-line bg-cos-paper px-3 py-1.5 text-[12.5px] font-semibold text-cos-ink hover:border-cos-brand/50 hover:bg-cos-brand-tint"
                  >
                    Resolver
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {data.empresas.length > 0 && (
        <div className="rounded-card border border-cos-line bg-cos-card px-4 py-4">
          <p className="mb-3 flex items-center gap-2 text-[13.5px] font-semibold text-cos-ink">
            <ClipboardCheck className="h-4 w-4 text-cos-brand" /> Cierres abiertos
          </p>
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {data.empresas.map((e) => {
              const pct = e.aplican > 0 ? Math.round((e.confirmados / e.aplican) * 100) : 0;
              return (
                <li key={`${e.companyId}-${e.year}-${e.month}`}>
                  <button
                    type="button"
                    onClick={() => irA(e.companyId, e.href)}
                    className="flex w-full items-center gap-3 rounded-control border border-cos-line px-3 py-2 text-left hover:border-cos-brand/50 hover:bg-cos-brand-tint"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-cos-ink">{e.empresa}</p>
                      <p className="text-[11.5px] text-cos-ink-soft">
                        {e.periodoLabel} · {e.confirmados}/{e.aplican} pasos confirmados
                        {e.bloquean > 0 && <span className="text-cos-red-ink"> · {e.bloquean} bloquea{e.bloquean === 1 ? "" : "n"}</span>}
                      </p>
                      <div className="mt-1.5 h-1 w-full rounded-full bg-cos-slate-tint">
                        <div className={cn("h-1 rounded-full", e.bloquean > 0 ? "bg-cos-red" : "bg-cos-jade")} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-cos-ink-faint" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
