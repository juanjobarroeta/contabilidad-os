"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, TrendingUp, AlertTriangle, Lock } from "lucide-react";
import { Card } from "@/components/ui";

type Plan = "ASISTENTE" | "AUTOMATIZADO" | "PRO" | "DESPACHO";
const PLAN_LABELS: Record<Plan, string> = { ASISTENTE: "Asistente", AUTOMATIZADO: "Automatizado", PRO: "Pro", DESPACHO: "Despacho" };

interface EmpresaRow {
  companyId: string;
  razonSocial: string;
  rfc: string;
  despachoId: string | null;
  plan: Plan;
  precioMensualCentavos: number | null;
  costoCentavos: number;
  costoSyntageCentavos: number;
  costoLlmCentavos: number;
  eventos: number;
  margenCentavos: number | null;
  margenPct: number | null;
}
interface DespachoRow {
  despachoId: string;
  name: string;
  empresas: number;
  precioMensualCentavos: number | null;
  costoCentavos: number;
  overheadCentavos: number;
  margenCentavos: number | null;
  margenPct: number | null;
}
interface Data {
  periodo: string;
  fixMxnPorUsd: number;
  fixReal: boolean;
  totalCostoCentavos: number;
  totalSyntageCentavos: number;
  totalLlmCentavos: number;
  empresas: EmpresaRow[];
  despachos: DespachoRow[];
}

const fmtMxn = (centavos: number | null) =>
  centavos == null
    ? "—"
    : (centavos / 100).toLocaleString("es-MX", { style: "currency", currency: "MXN" });
const fmtPct = (p: number | null) => (p == null ? "—" : `${(p * 100).toFixed(0)}%`);

export default function RentabilidadPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [data, setData] = useState<Data | null>(null);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/rentabilidad?year=${year}&month=${month}`);
      if (res.status === 403) {
        setDenied(true);
        return;
      }
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      setError("No se pudo cargar la rentabilidad.");
    } finally {
      setLoading(false);
    }
  }, [year, month]);

  useEffect(() => {
    load();
  }, [load]);

  async function savePrecio(tipo: "company" | "despacho", id: string, pesos: string) {
    const precioMensualCentavos = pesos.trim() === "" ? null : Math.round(Number(pesos) * 100);
    if (precioMensualCentavos != null && (!Number.isFinite(precioMensualCentavos) || precioMensualCentavos < 0)) return;
    await fetch("/api/rentabilidad/precio", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tipo, id, precioMensualCentavos }),
    });
    load();
  }

  async function savePlan(companyId: string, plan: string) {
    await fetch("/api/rentabilidad/plan", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ companyId, plan }),
    });
    load();
  }

  if (denied) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center">
        <Lock className="mb-3 h-9 w-9 text-cos-ink-faint" />
        <p className="text-sm font-medium text-cos-ink">Herramienta de operador</p>
        <p className="mt-1 text-xs text-cos-ink-soft">La rentabilidad por cliente sólo está disponible para el operador de plataforma.</p>
      </div>
    );
  }

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString("es-MX", { month: "long", year: "numeric" });
  const bajoAgua = (precio: number | null, costo: number) => precio != null && precio > 0 && costo > precio;
  const empresasBajoAgua = data?.empresas.filter((e) => bajoAgua(e.precioMensualCentavos, e.costoCentavos)) ?? [];
  const despBajoAgua = data?.despachos.filter((d) => bajoAgua(d.precioMensualCentavos, d.costoCentavos)) ?? [];
  const nBajoAgua = empresasBajoAgua.length + despBajoAgua.length;

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">
            <TrendingUp className="h-7 w-7 text-cos-brand-ink" /> Rentabilidad
          </h1>
          <p className="mt-1 max-w-[64ch] text-[15px] text-cos-ink-soft">
            Costo-por-servir (LLM + Syntage) vs precio mensual, por empresa y despacho. El costo se acumula desde
            que se activó la medición; los meses previos pueden verse bajos.
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button onClick={() => { const d = new Date(year, month - 2, 1); setYear(d.getFullYear()); setMonth(d.getMonth() + 1); }}
            aria-label="Mes anterior" className="grid h-8 w-8 place-items-center rounded-control border border-cos-line hover:bg-cos-paper">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[150px] text-center text-[15px] font-semibold capitalize text-cos-ink">{monthLabel}</span>
          <button onClick={() => { const d = new Date(year, month, 1); setYear(d.getFullYear()); setMonth(d.getMonth() + 1); }}
            aria-label="Mes siguiente" className="grid h-8 w-8 place-items-center rounded-control border border-cos-line hover:bg-cos-paper">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-control bg-cos-red-tint px-4 py-3 text-sm text-cos-red-ink">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-cos-ink-faint">
          <Loader2 className="h-5 w-5 animate-spin" /> Cargando…
        </div>
      ) : data ? (
        <div className="mt-5 space-y-6">
          {nBajoAgua > 0 && (
            <div className="flex items-start gap-2 rounded-card bg-cos-red-tint px-4 py-3 text-[13px] text-cos-red-ink">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-semibold">{nBajoAgua} cliente{nBajoAgua === 1 ? "" : "s"} bajo agua este mes</p>
                <p className="mt-0.5">
                  El costo-por-servir supera el precio en:{" "}
                  {[...empresasBajoAgua.map((e) => e.razonSocial), ...despBajoAgua.map((d) => d.name)].join(", ")}.
                </p>
              </div>
            </div>
          )}
          <div className="flex flex-wrap gap-3 text-[13px] text-cos-ink-soft">
            <span className="rounded-control bg-cos-slate-tint px-3 py-1.5">
              Costo total del mes: <b className="text-cos-ink">{fmtMxn(data.totalCostoCentavos)}</b>
            </span>
            <span className="rounded-control bg-cos-amber-tint px-3 py-1.5 text-cos-amber-ink">
              Datos (Syntage): <b>{fmtMxn(data.totalSyntageCentavos)}</b>
            </span>
            <span className="rounded-control bg-cos-brand-tint px-3 py-1.5 text-cos-brand-ink">
              IA (LLM): <b>{fmtMxn(data.totalLlmCentavos)}</b>
            </span>
            {data.empresas.length > 0 && (
              <span className="rounded-control bg-cos-slate-tint px-3 py-1.5">
                Costo prom./empresa: <b className="text-cos-ink">{fmtMxn(Math.round(data.totalCostoCentavos / data.empresas.length))}</b>
              </span>
            )}
            <span className="rounded-control bg-cos-slate-tint px-3 py-1.5">
              FIX {data.fixMxnPorUsd.toFixed(4)} MXN/USD {data.fixReal ? "(Banxico)" : "(aprox.)"}
            </span>
          </div>

          <TrendCard />

          {/* Despacho roll-up */}
          {data.despachos.length > 0 && (
            <Card className="overflow-hidden rounded-card border-cos-line shadow-card">
              <div className="border-b border-cos-line px-5 py-3 text-[13px] font-semibold uppercase tracking-[0.02em] text-cos-ink-faint">
                Por despacho
              </div>
              <Tabla
                filas={data.despachos.map((d) => ({
                  id: d.despachoId, nombre: d.name, sub: `${d.empresas} empresa${d.empresas === 1 ? "" : "s"} · overhead ${fmtMxn(d.overheadCentavos)}`,
                  costoCentavos: d.costoCentavos, precioMensualCentavos: d.precioMensualCentavos,
                  margenCentavos: d.margenCentavos, margenPct: d.margenPct, tipo: "despacho" as const,
                }))}
                onSave={savePrecio}
              />
            </Card>
          )}

          {/* Por empresa */}
          <Card className="overflow-hidden rounded-card border-cos-line shadow-card">
            <div className="border-b border-cos-line px-5 py-3 text-[13px] font-semibold uppercase tracking-[0.02em] text-cos-ink-faint">
              Por empresa
            </div>
            <Tabla
              filas={data.empresas.map((e) => ({
                id: e.companyId, nombre: e.razonSocial, sub: e.rfc,
                costoCentavos: e.costoCentavos, precioMensualCentavos: e.precioMensualCentavos,
                margenCentavos: e.margenCentavos, margenPct: e.margenPct, tipo: "company" as const,
                costoSyntageCentavos: e.costoSyntageCentavos, costoLlmCentavos: e.costoLlmCentavos,
                plan: e.plan,
              }))}
              onSave={savePrecio}
              onSavePlan={savePlan}
            />
          </Card>
        </div>
      ) : null}
    </div>
  );
}

interface TrendPoint { periodo: string; llmCentavos: number; syntageCentavos: number; totalCentavos: number }

function TrendCard() {
  const [serie, setSerie] = useState<TrendPoint[] | null>(null);
  useEffect(() => {
    fetch("/api/rentabilidad/tendencia?meses=6")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setSerie(d?.serie ?? []))
      .catch(() => setSerie([]));
  }, []);
  if (!serie || serie.length === 0) return null;
  const max = Math.max(1, ...serie.map((p) => p.totalCentavos));

  return (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[14px] font-semibold text-cos-ink">Costo por mes (últimos 6)</h3>
        <div className="flex items-center gap-3 text-[11.5px] text-cos-ink-soft">
          <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-cos-brand-ink" /> LLM</span>
          <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm bg-cos-amber" /> Syntage</span>
        </div>
      </div>
      <div className="mt-3 flex h-[140px] items-end gap-2">
        {serie.map((p) => {
          const llmH = (p.llmCentavos / max) * 100;
          const synH = (p.syntageCentavos / max) * 100;
          const mes = new Date(Number(p.periodo.slice(0, 4)), Number(p.periodo.slice(5, 7)) - 1, 1)
            .toLocaleDateString("es-MX", { month: "short" });
          return (
            <div key={p.periodo} className="flex flex-1 flex-col items-center gap-1.5">
              <div className="flex w-full flex-1 flex-col justify-end" title={`${p.periodo}: ${fmtMxn(p.totalCentavos)}`}>
                <div className="w-full rounded-t-[3px] bg-cos-amber" style={{ height: `${synH}%` }} />
                <div className={`w-full bg-cos-brand-ink ${synH > 0 ? "" : "rounded-t-[3px]"}`} style={{ height: `${llmH}%` }} />
              </div>
              <span className="text-[10.5px] capitalize text-cos-ink-faint">{mes}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

interface Fila {
  id: string;
  nombre: string;
  sub: string;
  costoCentavos: number;
  precioMensualCentavos: number | null;
  margenCentavos: number | null;
  margenPct: number | null;
  tipo: "company" | "despacho";
  /** Desglose del costo (sólo empresas) — base de precios. */
  costoSyntageCentavos?: number;
  costoLlmCentavos?: number;
  plan?: Plan;
}

function Tabla({ filas, onSave, onSavePlan }: {
  filas: Fila[];
  onSave: (tipo: "company" | "despacho", id: string, pesos: string) => void;
  onSavePlan?: (companyId: string, plan: string) => void;
}) {
  return (
    <div className="divide-y divide-cos-line">
      <div className="hidden grid-cols-[1fr_130px_130px_130px_80px] gap-3 px-5 py-2 text-[11.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint sm:grid">
        <span>Nombre</span>
        <span className="text-right">Costo</span>
        <span className="text-right">Precio / mes</span>
        <span className="text-right">Margen</span>
        <span className="text-right">%</span>
      </div>
      {filas.map((f) => (
        <FilaRow key={f.id} f={f} onSave={onSave} onSavePlan={onSavePlan} />
      ))}
      {filas.length === 0 && <p className="px-5 py-6 text-center text-[13px] text-cos-ink-faint">Sin datos.</p>}
    </div>
  );
}

function FilaRow({ f, onSave, onSavePlan }: {
  f: Fila;
  onSave: (tipo: "company" | "despacho", id: string, pesos: string) => void;
  onSavePlan?: (companyId: string, plan: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(f.precioMensualCentavos != null ? String(f.precioMensualCentavos / 100) : "");
  const underwater = f.margenCentavos != null && f.margenCentavos < 0;

  function commit() {
    setEditing(false);
    const current = f.precioMensualCentavos != null ? String(f.precioMensualCentavos / 100) : "";
    if (val !== current) onSave(f.tipo, f.id, val);
  }

  return (
    <div className={`grid grid-cols-2 gap-3 px-5 py-3 sm:grid-cols-[1fr_130px_130px_130px_80px] sm:items-center ${underwater ? "bg-cos-red-tint" : ""}`}>
      <div className="col-span-2 min-w-0 sm:col-span-1">
        <p className="truncate text-[14px] font-medium text-cos-ink">{f.nombre}</p>
        <p className="truncate font-mono text-[11.5px] text-cos-ink-faint">{f.sub}</p>
        {f.plan && onSavePlan && (
          <select
            value={f.plan}
            onChange={(e) => onSavePlan(f.id, e.target.value)}
            className="mt-1 rounded-control border border-cos-line bg-white px-1.5 py-0.5 text-[11.5px] text-cos-ink-soft outline-none focus:border-cos-brand-ink"
            title="Plan/tier — define qué COGS se incurre (Syntage/banco/WhatsApp)"
          >
            {(Object.keys(PLAN_LABELS) as Plan[]).map((p) => (
              <option key={p} value={p}>{PLAN_LABELS[p]}</option>
            ))}
          </select>
        )}
      </div>
      <div className="text-right text-[13.5px] text-cos-ink-soft">
        {fmtMxn(f.costoCentavos)}
        {(f.costoSyntageCentavos != null || f.costoLlmCentavos != null) && (f.costoCentavos > 0) && (
          <div className="text-[11px] text-cos-ink-faint">
            <span className="text-cos-amber-ink">Datos {fmtMxn(f.costoSyntageCentavos ?? 0)}</span>
            {" · "}
            <span className="text-cos-brand-ink">IA {fmtMxn(f.costoLlmCentavos ?? 0)}</span>
          </div>
        )}
      </div>
      <div className="text-right">
        {editing ? (
          <input
            autoFocus
            type="number"
            min="0"
            step="1"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
            placeholder="—"
            className="w-[110px] rounded-control border border-cos-line px-2 py-1 text-right text-[13.5px] outline-none focus:border-cos-brand-ink"
          />
        ) : (
          <button onClick={() => setEditing(true)} className="text-[13.5px] text-cos-ink underline decoration-dotted underline-offset-2 hover:text-cos-brand-ink">
            {fmtMxn(f.precioMensualCentavos)}
          </button>
        )}
      </div>
      <div className={`text-right text-[13.5px] font-semibold ${f.margenCentavos == null ? "text-cos-ink-faint" : underwater ? "text-cos-red-ink" : "text-cos-jade-ink"}`}>
        {fmtMxn(f.margenCentavos)}
      </div>
      <div className={`text-right text-[13px] ${underwater ? "text-cos-red-ink" : "text-cos-ink-soft"}`}>{fmtPct(f.margenPct)}</div>
    </div>
  );
}
