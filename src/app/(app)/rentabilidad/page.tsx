"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ChevronDown, Loader2, TrendingUp, AlertTriangle, Lock, CheckCircle2, XCircle } from "lucide-react";
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
  costoFacturapiCentavos: number;
  timbresMes: number;
  timbresIncluidos: number;
  timbresExcedente: number;
  cargoExcedenteCentavos: number;
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
  totalFacturapiCentavos: number;
  empresas: EmpresaRow[];
  despachos: DespachoRow[];
}

// ── Drill-down por empresa (coincide con /api/rentabilidad/empresa/[id]) ──────
const EXTRACTOR_LABELS: Record<string, string> = {
  tax_compliance: "Opinión de cumplimiento",
  tax_status: "Constancia (CSF)",
  annual_tax_return: "Declaración anual",
  monthly_tax_return: "Declaraciones mensuales",
};
const DECL_LABELS: Record<string, string> = {
  IVA_MENSUAL: "IVA mensual",
  ISR_PROVISIONAL: "ISR provisional",
  DECLARACION_ANUAL: "Anual",
  DIOT: "DIOT",
  RETENCIONES_ISR: "Retenciones ISR",
  CERO: "En ceros",
};
interface CostoSubtipo { subtipo: string; categoria: string; eventos: number; unidades: number; costoCentavos: number; ultimoAt: string | null }
interface CoberturaExtractor { extractor: string; ultimaAt: string | null; datoPresente: boolean }
interface CoberturaCompliance { tipo: string; resultado: string | null; fetchedAt: string | null }
interface CoberturaDeclaracion { tipo: string; total: number; periodos: string[] }
interface EmpresaDetalle {
  companyId: string; razonSocial: string; rfc: string; periodo: string;
  totalCentavos: number; costos: CostoSubtipo[];
  extracciones: CoberturaExtractor[]; compliance: CoberturaCompliance[]; declaraciones: CoberturaDeclaracion[];
}

const fmtFecha = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" }) : "—";

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

  // «Agosto 2026» como en el resto de la app — la clase `capitalize` sobre
  // «agosto de 2026» pintaba «Agosto De 2026».
  const mesLargo = new Date(year, month - 1, 1).toLocaleDateString("es-MX", { month: "long" });
  const monthLabel = `${mesLargo.charAt(0).toUpperCase()}${mesLargo.slice(1)} ${year}`;
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
          <span className="min-w-[150px] text-center text-[15px] font-semibold text-cos-ink">{monthLabel}</span>
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
            <span className="rounded-control bg-cos-jade-tint px-3 py-1.5 text-cos-jade-ink">
              Timbrado (Facturapi): <b>{fmtMxn(data.totalFacturapiCentavos)}</b>
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
                costoFacturapiCentavos: e.costoFacturapiCentavos, timbresMes: e.timbresMes,
                timbresIncluidos: e.timbresIncluidos, timbresExcedente: e.timbresExcedente,
                cargoExcedenteCentavos: e.cargoExcedenteCentavos,
                plan: e.plan,
              }))}
              onSave={savePrecio}
              onSavePlan={savePlan}
              year={year}
              month={month}
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
  costoFacturapiCentavos?: number;
  timbresMes?: number;
  timbresIncluidos?: number;
  timbresExcedente?: number;
  cargoExcedenteCentavos?: number;
  plan?: Plan;
}

function Tabla({ filas, onSave, onSavePlan, year, month }: {
  filas: Fila[];
  onSave: (tipo: "company" | "despacho", id: string, pesos: string) => void;
  onSavePlan?: (companyId: string, plan: string) => void;
  year?: number;
  month?: number;
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
        <FilaRow key={f.id} f={f} onSave={onSave} onSavePlan={onSavePlan} year={year} month={month} />
      ))}
      {filas.length === 0 && <p className="px-5 py-6 text-center text-[13px] text-cos-ink-faint">Sin datos.</p>}
    </div>
  );
}

function FilaRow({ f, onSave, onSavePlan, year, month }: {
  f: Fila;
  onSave: (tipo: "company" | "despacho", id: string, pesos: string) => void;
  onSavePlan?: (companyId: string, plan: string) => void;
  year?: number;
  month?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(f.precioMensualCentavos != null ? String(f.precioMensualCentavos / 100) : "");
  const [open, setOpen] = useState(false);
  const underwater = f.margenCentavos != null && f.margenCentavos < 0;
  const expandable = f.tipo === "company" && year != null && month != null;

  function commit() {
    setEditing(false);
    const current = f.precioMensualCentavos != null ? String(f.precioMensualCentavos / 100) : "";
    if (val !== current) onSave(f.tipo, f.id, val);
  }

  return (
    <>
    <div className={`grid grid-cols-2 gap-3 px-5 py-3 sm:grid-cols-[1fr_130px_130px_130px_80px] sm:items-center ${underwater ? "bg-cos-red-tint" : ""}`}>
      <div className="col-span-2 min-w-0 sm:col-span-1">
        <div className="flex items-center gap-1.5">
          {expandable && (
            <button
              onClick={() => setOpen((o) => !o)}
              aria-label={open ? "Ocultar detalle" : "Ver detalle"}
              className="grid h-5 w-5 shrink-0 place-items-center rounded-control text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink"
            >
              <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
          )}
          <p className="truncate text-[14px] font-medium text-cos-ink">{f.nombre}</p>
        </div>
        <p className={`truncate font-mono text-[11.5px] text-cos-ink-faint ${expandable ? "pl-[26px]" : ""}`}>{f.sub}</p>
        {f.plan && onSavePlan && (
          <select
            value={f.plan}
            onChange={(e) => onSavePlan(f.id, e.target.value)}
            className="mt-1 rounded-control border border-cos-line bg-cos-card px-1.5 py-0.5 text-[11.5px] text-cos-ink-soft outline-none focus:border-cos-brand-ink"
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
        {(f.costoSyntageCentavos != null || f.costoLlmCentavos != null || f.costoFacturapiCentavos != null) && (f.costoCentavos > 0) && (
          <div className="text-[11px] text-cos-ink-faint">
            <span className="text-cos-amber-ink">Datos {fmtMxn(f.costoSyntageCentavos ?? 0)}</span>
            {" · "}
            <span className="text-cos-brand-ink">IA {fmtMxn(f.costoLlmCentavos ?? 0)}</span>
            {" · "}
            <span className="text-cos-jade-ink">Timbrado {fmtMxn(f.costoFacturapiCentavos ?? 0)}</span>
            {f.timbresIncluidos != null ? (
              <span className="text-cos-ink-faint">
                {" "}({f.timbresMes ?? 0}/{f.timbresIncluidos} timbres
                {f.timbresExcedente ? (
                  <span className="text-cos-red-ink"> · excedente {f.timbresExcedente} → cobrar {fmtMxn(f.cargoExcedenteCentavos ?? 0)}</span>
                ) : null}
                )
              </span>
            ) : null}
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
    {expandable && open && <EmpresaDetallePanel companyId={f.id} year={year!} month={month!} />}
    </>
  );
}

function EmpresaDetallePanel({ companyId, year, month }: { companyId: string; year: number; month: number }) {
  const [data, setData] = useState<EmpresaDetalle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(false);
    fetch(`/api/rentabilidad/empresa/${companyId}?year=${year}&month=${month}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { if (!cancel) setData(d); })
      .catch(() => { if (!cancel) setError(true); })
      .finally(() => { if (!cancel) setLoading(false); });
    return () => { cancel = true; };
  }, [companyId, year, month]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 bg-cos-paper px-5 py-4 text-[12.5px] text-cos-ink-faint">
        <Loader2 className="h-4 w-4 animate-spin" /> Cargando detalle…
      </div>
    );
  }
  if (error || !data) {
    return <div className="bg-cos-paper px-5 py-4 text-[12.5px] text-cos-red-ink">No se pudo cargar el detalle.</div>;
  }

  const sinDato = data.extracciones.filter((e) => !e.datoPresente);

  return (
    <div className="space-y-4 bg-cos-paper px-5 py-4">
      {sinDato.length > 0 && (
        <div className="flex items-start gap-2 rounded-control bg-cos-amber-tint px-3 py-2 text-[12px] text-cos-amber-ink">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Falta dato en: <b>{sinDato.map((e) => EXTRACTOR_LABELS[e.extractor] ?? e.extractor).join(", ")}</b>. Se
            re-extraerá automáticamente (cadencia por presencia de dato).
          </span>
        </div>
      )}

      {/* Cobertura de datos */}
      <div>
        <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.02em] text-cos-ink-faint">Cobertura de datos (estado actual)</p>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {data.extracciones.map((e) => (
            <div key={e.extractor} className="flex items-center justify-between gap-2 rounded-control bg-cos-card px-3 py-1.5 text-[12.5px]">
              <span className="flex items-center gap-1.5 text-cos-ink-soft">
                {e.datoPresente ? <CheckCircle2 className="h-3.5 w-3.5 text-cos-jade-ink" /> : <XCircle className="h-3.5 w-3.5 text-cos-red-ink" />}
                {EXTRACTOR_LABELS[e.extractor] ?? e.extractor}
              </span>
              <span className="text-[11px] text-cos-ink-faint">últ. {fmtFecha(e.ultimaAt)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Compliance + declaraciones */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-control bg-cos-card px-3 py-2.5">
          <p className="mb-1.5 text-[11.5px] font-semibold text-cos-ink">Cumplimiento</p>
          {data.compliance.map((c) => (
            <div key={c.tipo} className="flex justify-between gap-2 py-0.5 text-[12px] text-cos-ink-soft">
              <span>{c.tipo === "SAT_OPINION" ? "Opinión SAT" : c.tipo === "CSF" ? "Constancia (CSF)" : "Opinión IMSS"}</span>
              <span className="text-cos-ink-faint">{c.resultado ?? "—"} · {fmtFecha(c.fetchedAt)}</span>
            </div>
          ))}
        </div>
        <div className="rounded-control bg-cos-card px-3 py-2.5">
          <p className="mb-1.5 text-[11.5px] font-semibold text-cos-ink">Declaraciones persistidas</p>
          {data.declaraciones.length === 0 ? (
            <p className="py-0.5 text-[12px] text-cos-ink-faint">Ninguna.</p>
          ) : (
            data.declaraciones.map((d) => (
              <div key={d.tipo} className="flex justify-between gap-2 py-0.5 text-[12px] text-cos-ink-soft">
                <span>{DECL_LABELS[d.tipo] ?? d.tipo}</span>
                <span className="text-cos-ink-faint">{d.total} · {d.periodos.slice(0, 3).join(", ")}{d.total > 3 ? "…" : ""}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Costo del mes por subtipo */}
      <div>
        <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-[0.02em] text-cos-ink-faint">
          Costo del mes por concepto · total {fmtMxn(data.totalCentavos)}
        </p>
        {data.costos.length === 0 ? (
          <p className="text-[12px] text-cos-ink-faint">Sin eventos de costo este mes.</p>
        ) : (
          <div className="overflow-hidden rounded-control bg-cos-card">
            {data.costos.map((c) => (
              <div key={c.subtipo} className="flex items-center justify-between gap-2 border-b border-cos-line px-3 py-1.5 text-[12px] last:border-b-0">
                <span className="truncate font-mono text-[11px] text-cos-ink-soft">{c.subtipo}</span>
                <span className="flex shrink-0 items-center gap-3 text-cos-ink-faint">
                  <span>{c.eventos}×</span>
                  <span className="w-[80px] text-right font-medium text-cos-ink-soft">{fmtMxn(c.costoCentavos)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
