"use client";

// ─────────────────────────────────────────────────────────────────────────────
// LENTE CARTERA del nuevo Inicio: la cola de trabajo del despacho (Propuesta
// A del rediseño). Una fila por cosa-que-hacer, UNA acción por fila; el click
// activa la empresa de la fila y navega a donde se resuelve.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Alert, Loading, RetryButton } from "@/components/ui/feedback";
import { Money } from "@/components/ui/Money";
import { cn } from "@/lib/utils";
import type { FilaCola, ResumenCola, CategoriaCola } from "@/lib/inicio/cola";

interface AgendaItem {
  fecha: string;
  fechaFmt: string;
  label: string;
  detalle: string;
}

interface ColaResponse {
  filas: FilaCola[];
  resumen: ResumenCola | null;
  agenda: AgendaItem[];
  empresas: number;
}

const CATEGORIA_CHIP: Record<CategoriaCola, string> = {
  FISCAL: "bg-cos-red-tint text-cos-red-ink",
  NOMINA: "bg-cos-brand-tint text-cos-brand-ink",
  BANCOS: "bg-cos-amber-tint text-cos-amber-ink",
  CIERRE: "bg-cos-jade-tint text-cos-jade-ink",
  SETUP: "bg-cos-slate-tint text-cos-ink-soft",
};

const FILTROS: { valor: "TODO" | CategoriaCola; label: string }[] = [
  { valor: "TODO", label: "Todo" },
  { valor: "FISCAL", label: "Fiscal" },
  { valor: "NOMINA", label: "Nómina" },
  { valor: "BANCOS", label: "Bancos" },
];

export function ColaDeTrabajo() {
  const router = useRouter();
  const { companies, setActiveCompany } = useCompany();
  const [data, setData] = useState<ColaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState<"TODO" | CategoriaCola>("TODO");

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/inicio/cola");
      const j = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(j?.filas)) throw new Error(j?.error ?? `HTTP ${res.status}`);
      setData(j as ColaResponse);
    } catch {
      setData(null);
      setError("No se pudo cargar la cola de trabajo.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  function irA(fila: FilaCola) {
    const empresa = companies.find((c) => c.id === fila.companyId);
    if (empresa) setActiveCompany(empresa);
    router.push(fila.cta.href);
  }

  if (error) {
    return (
      <Alert tone="danger" action={<RetryButton onClick={cargar} />}>
        {error}
      </Alert>
    );
  }
  if (loading || !data) return <Loading label="Armando la cola de trabajo…" />;

  const r = data.resumen;
  const filas = filtro === "TODO" ? data.filas : data.filas.filter((f) => f.categoria === filtro);

  return (
    <div>
      {r && (
        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div
            className={cn(
              "rounded-card border px-4 py-3",
              r.rfcsVencidos > 0 ? "border-cos-red-ink/30 bg-cos-red-tint" : "border-cos-line bg-cos-card",
            )}
          >
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-cos-ink-faint">
              Vencido
            </p>
            <p className={cn("mt-1", r.rfcsVencidos > 0 ? "text-cos-red-ink" : "text-cos-ink")}>
              <Money value={r.vencidoMonto} size={22} weight={700} className={r.rfcsVencidos > 0 ? "text-cos-red-ink" : undefined} />
            </p>
            <p className="mt-0.5 text-[12px] text-cos-ink-soft">
              {r.rfcsVencidos === 0
                ? "sin declaraciones vencidas"
                : `${r.rfcsVencidos} RFC con recargos corriendo${r.vencidoSinImporte > 0 ? ` · ${r.vencidoSinImporte} sin importe` : ""}`}
            </p>
          </div>
          <div className="rounded-card border border-cos-line bg-cos-card px-4 py-3">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-cos-ink-faint">
              Por presentar
            </p>
            <p className="mt-1 text-[22px] font-bold tabular-nums text-cos-ink">{r.declaracionesPorPresentar}</p>
            <p className="mt-0.5 text-[12px] text-cos-ink-soft">declaraciones del periodo</p>
          </div>
          <div className="rounded-card border border-cos-line bg-cos-card px-4 py-3">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-cos-ink-faint">
              Nómina
            </p>
            <p className="mt-1 text-[22px] font-bold tabular-nums text-cos-ink">{r.nominasSinTimbrar}</p>
            <p className="mt-0.5 text-[12px] text-cos-ink-soft">empresas con corrida sin timbrar</p>
          </div>
          <div className="rounded-card border border-cos-line bg-cos-card px-4 py-3">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-cos-ink-faint">
              Conciliación
            </p>
            <p className="mt-1 text-[22px] font-bold tabular-nums text-cos-ink">{r.movimientosSinClasificar}</p>
            <p className="mt-0.5 text-[12px] text-cos-ink-soft">movimientos sin clasificar</p>
          </div>
        </div>
      )}

      <div className="rounded-card border border-cos-line bg-cos-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-cos-line px-4 py-3">
          <p className="text-[14px] font-semibold text-cos-ink">
            Cola de trabajo <span className="text-cos-ink-faint">{data.filas.length}</span>
          </p>
          <div className="flex gap-1">
            {FILTROS.map((f) => (
              <button
                key={f.valor}
                type="button"
                onClick={() => setFiltro(f.valor)}
                className={cn(
                  "rounded-full px-3 py-1 text-[12.5px] font-medium",
                  filtro === f.valor
                    ? "bg-cos-brand text-white"
                    : "text-cos-ink-soft hover:bg-cos-paper hover:text-cos-ink",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {filas.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13.5px] text-cos-jade-ink">
            {filtro === "TODO"
              ? "Cartera al corriente — nada urgente en la cola."
              : "Nada pendiente en esta categoría."}
          </p>
        ) : (
          <ul className="divide-y divide-cos-line-soft">
            {filas.map((f, i) => (
              <li key={`${f.companyId}-${f.categoria}-${i}`} className="flex items-center gap-3 px-4 py-3">
                <span
                  className={cn(
                    "w-1 self-stretch rounded-full",
                    f.urgencia === "vencido" ? "bg-cos-red" : f.urgencia === "hoy" ? "bg-cos-amber" : "bg-cos-line",
                  )}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[13.5px] font-semibold text-cos-ink">
                    <span className="truncate">{f.empresa}</span>
                    <span className={cn("rounded-full px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-wide", CATEGORIA_CHIP[f.categoria])}>
                      {f.categoria}
                    </span>
                  </p>
                  <p className="truncate text-[12.5px] text-cos-ink-soft">{f.detalle}</p>
                </div>
                <div className="hidden text-right sm:block">
                  {f.monto !== null ? <Money value={f.monto} weight={700} /> : <span className="text-cos-ink-faint">—</span>}
                </div>
                <span
                  className={cn(
                    "hidden w-24 text-right text-[12px] md:block",
                    f.urgencia === "vencido" ? "font-semibold text-cos-red-ink" : f.urgencia === "cuando_quieras" ? "text-cos-jade-ink" : "text-cos-ink-soft",
                  )}
                >
                  {f.vence}
                </span>
                <button
                  type="button"
                  onClick={() => irA(f)}
                  className="shrink-0 rounded-control border border-cos-line bg-cos-paper px-3 py-1.5 text-[12.5px] font-semibold text-cos-ink hover:border-cos-brand/50 hover:bg-cos-brand-tint"
                >
                  {f.cta.label}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {data.agenda.length > 0 && (
        <div className="mt-5 rounded-card border border-cos-line bg-cos-card px-4 py-4">
          <p className="mb-3 text-[13.5px] font-semibold text-cos-ink">Agenda fiscal · próximos 30 días</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {data.agenda.map((a) => (
              <div key={a.label + a.fecha} className="border-l-2 border-cos-brand/40 pl-3">
                <p className="font-mono text-[11px] font-bold text-cos-amber-ink">{a.fechaFmt}</p>
                <p className="text-[13px] font-semibold text-cos-ink">{a.label}</p>
                <p className="text-[11.5px] text-cos-ink-soft">{a.detalle}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
