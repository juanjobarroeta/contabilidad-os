"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronLeft, ChevronRight, CheckCircle2, AlertTriangle, Clock,
  Loader2, RefreshCw, Upload, FileCheck, Info, CalendarDays,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { CumplimientoTabs } from "@/components/layout/CumplimientoTabs";
import { Card, Chip, type ChipStatus } from "@/components/ui";

// ── Types (mirrors /api/obligaciones) ─────────────────────────────────────────
type Estado = "FILED" | "PENDING" | "OVERDUE" | "UPCOMING" | "NOT_APPLICABLE";
interface PeriodoItem { periodo: string; label: string; vencimiento: string; estado: Estado; declaracionStatus: string | null }
interface ObligacionCalendar { tipo: string; descripcion: string; periodicidad: string; fuente: string; periodos: PeriodoItem[] }
interface CalendarData { year: number; obligaciones: ObligacionCalendar[] }

// Estado → shared status vocabulary + cos cell styling.
const ESTADO: Record<Estado, { chip: ChipStatus | null; cell: string; text: string; icon: typeof CheckCircle2 | null }> = {
  FILED:          { chip: "presentada",  cell: "bg-cos-jade-tint border-[oklch(0.66_0.12_168_/_0.28)]",  text: "text-cos-jade-ink",  icon: CheckCircle2 },
  OVERDUE:        { chip: "vencida",     cell: "bg-cos-red-tint border-[oklch(0.6_0.2_25_/_0.22)]",      text: "text-cos-red-ink",   icon: AlertTriangle },
  UPCOMING:       { chip: "porvencer",   cell: "bg-cos-amber-tint border-[oklch(0.74_0.13_72_/_0.28)]",  text: "text-cos-amber-ink", icon: Clock },
  PENDING:        { chip: "pendiente",   cell: "bg-cos-slate-tint border-transparent",                   text: "text-cos-ink-soft",  icon: Clock },
  NOT_APPLICABLE: { chip: null,          cell: "bg-cos-paper border-transparent",                         text: "text-cos-ink-faint", icon: null },
};
const LBL = "block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint";

function fmtShort(iso: string) {
  return new Date(iso).toLocaleDateString("es-MX", { day: "numeric", month: "short" });
}
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function CumplimientoPage() {
  const { activeCompany } = useCompany();
  const router = useRouter();
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [csfResult, setCsfResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true); setError("");
    try {
      const res = await fetch(`/api/obligaciones?companyId=${activeCompany.id}&year=${year}`);
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      setError("No se pudo cargar el calendario de obligaciones");
    } finally {
      setLoading(false);
    }
  }, [activeCompany, year]);

  useEffect(() => { load(); }, [load]);

  async function handleCsfUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !activeCompany) return;
    setUploading(true); setCsfResult(null); setError("");
    try {
      const base64 = await fileToBase64(file);
      const res = await fetch("/api/obligaciones/csf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, csfBase64: base64 }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error ?? "Error al procesar CSF");
      setCsfResult(result.message);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al procesar la CSF");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  const summary = data?.obligaciones.flatMap((o) => o.periodos).reduce(
    (acc, p) => { acc[p.estado] = (acc[p.estado] ?? 0) + 1; return acc; },
    {} as Record<string, number>
  );
  const overdue = summary?.OVERDUE ?? 0;
  const upcoming = summary?.UPCOMING ?? 0;
  const filed = summary?.FILED ?? 0;

  if (!activeCompany) return <div className="p-8 text-sm text-cos-ink-faint">Selecciona una empresa para ver su calendario fiscal.</div>;

  // Calm hero — the emotional center of the app.
  let hero: { tone: "red" | "amber" | "jade"; icon: typeof CheckCircle2; title: string; body: string };
  if (overdue > 0) hero = { tone: "red", icon: AlertTriangle, title: overdue === 1 ? "Tienes 1 obligación vencida" : `Tienes ${overdue} obligaciones vencidas`, body: "Preséntalas cuanto antes para frenar recargos y multas." };
  else if (upcoming > 0) hero = { tone: "amber", icon: Clock, title: upcoming === 1 ? "1 obligación por vencer" : `${upcoming} obligaciones por vencer`, body: "Tienes tiempo — prepáralas antes de la fecha límite." };
  else hero = { tone: "jade", icon: CheckCircle2, title: "Estás al día", body: "No tienes obligaciones vencidas ni próximas a vencer. Todo en orden." };
  const band = { red: "bg-cos-red-tint", amber: "bg-cos-amber-tint", jade: "bg-cos-jade-tint" }[hero.tone];
  const tile = { red: "bg-cos-red", amber: "bg-cos-amber", jade: "bg-cos-jade" }[hero.tone];
  const ink = { red: "text-cos-red-ink", amber: "text-cos-amber-ink", jade: "text-cos-jade-ink" }[hero.tone];

  function goToPeriodo(periodo: string) {
    if (periodo.includes("-") && !periodo.includes("-B")) {
      const [y, m] = periodo.split("-");
      router.push(`/impuestos?month=${parseInt(m)}&year=${parseInt(y)}`);
    } else {
      router.push("/impuestos?tab=del-mes");
    }
  }

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-8 sm:py-8">
      <CumplimientoTabs />
      {/* header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Cumplimiento</h1>
          <p className="mt-1.5 text-[14px] font-medium text-cos-brand-ink">
            {activeCompany.razonSocial} · <span className="font-mono text-cos-ink-soft">{activeCompany.rfc}</span>
          </p>
          <p className="mt-1 max-w-[60ch] text-[15px] text-cos-ink-soft">Calendario fiscal de <strong>esta empresa</strong> con el SAT — qué presentaste, qué falta y cuándo vence. Cambia de empresa en el selector de arriba.</p>
        </div>
        <label className={`inline-flex cursor-pointer items-center gap-2 rounded-control border px-4 py-2 text-[14px] font-semibold transition-colors ${uploading ? "pointer-events-none border-cos-line bg-cos-paper text-cos-ink-faint" : "border-cos-line bg-cos-card text-cos-ink hover:bg-cos-paper"}`}>
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {uploading ? "Procesando CSF…" : "Subir CSF"}
          <input type="file" accept=".pdf" className="hidden" onChange={handleCsfUpload} disabled={uploading} />
        </label>
      </div>

      {/* year nav */}
      <div className="mt-4 flex items-center gap-2.5">
        <button onClick={() => setYear((y) => y - 1)} aria-label="Año anterior" className="grid h-8 w-8 place-items-center rounded-control border border-cos-line hover:bg-cos-paper"><ChevronLeft className="h-4 w-4" /></button>
        <span className="min-w-[72px] text-center text-[17px] font-semibold text-cos-ink">{year}</span>
        <button onClick={() => setYear((y) => y + 1)} aria-label="Año siguiente" className="grid h-8 w-8 place-items-center rounded-control border border-cos-line hover:bg-cos-paper"><ChevronRight className="h-4 w-4" /></button>
        <button onClick={load} disabled={loading} aria-label="Recargar" className="grid h-8 w-8 place-items-center rounded-control border border-cos-line hover:bg-cos-paper disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /></button>
      </div>

      {error && <div className="mt-4 flex items-center gap-2 rounded-control bg-cos-red-tint px-4 py-3 text-sm text-cos-red-ink"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div>}
      {csfResult && <div className="mt-4 flex items-start gap-2 rounded-control bg-cos-jade-tint px-4 py-3 text-sm text-cos-jade-ink"><FileCheck className="mt-0.5 h-4 w-4 shrink-0" />{csfResult}</div>}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-cos-ink-faint"><Loader2 className="h-5 w-5 animate-spin" /> Cargando calendario…</div>
      ) : data ? (
        <div className="mt-5 space-y-5">
          {/* hero */}
          <div className={`flex items-center gap-4 rounded-card px-6 py-[22px] ${band}`}>
            <div className={`grid h-12 w-12 flex-none place-items-center rounded-[14px] text-white ${tile}`}><hero.icon className="h-[26px] w-[26px]" strokeWidth={2.2} /></div>
            <div>
              <h2 className={`text-[21px] font-semibold tracking-[-0.02em] ${ink}`}>{hero.title}</h2>
              <p className={`mt-1 text-[14.5px] leading-snug ${ink} opacity-90`}>{hero.body}</p>
            </div>
          </div>

          {/* summary */}
          <div className="grid grid-cols-1 gap-4 min-[560px]:grid-cols-3">
            <SummaryCard label="Vencidas" count={overdue} tone={overdue > 0 ? "red" : "neutral"} icon={AlertTriangle} />
            <SummaryCard label="Por vencer (30 días)" count={upcoming} tone={upcoming > 0 ? "amber" : "neutral"} icon={Clock} />
            <SummaryCard label="Presentadas este año" count={filed} tone="jade" icon={CheckCircle2} />
          </div>

          {data.obligaciones.length === 0 && (
            <Card className="rounded-card border-cos-line p-10 text-center shadow-card">
              <CalendarDays className="mx-auto mb-3 h-10 w-10 text-cos-ink-faint opacity-40" />
              <p className="text-sm font-medium text-cos-ink">Sin obligaciones registradas</p>
              <p className="mt-1 text-xs text-cos-ink-soft">Sube tu CSF para que el sistema detecte automáticamente tus obligaciones fiscales.</p>
            </Card>
          )}

          {data.obligaciones.map((ob) => (
            <ObligacionCard key={ob.tipo} ob={ob} onPeriodoClick={goToPeriodo} />
          ))}

          {/* Cobertura de datos fiscales (frescura time-aware de tarifas/INPC/UMA…) */}
          <CoberturaFiscalCard />

          {/* CSF info */}
          <div className="flex items-start gap-3 rounded-card border border-dashed border-cos-line bg-cos-brand-tint px-4 py-3 text-[13px] text-cos-brand-ink">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="mb-0.5 font-semibold">¿Cómo funciona?</p>
              <p>Las obligaciones se generan según tu régimen fiscal (<strong>{activeCompany.regimenFiscal}</strong>). Para mayor precisión, sube tu <strong>Constancia de Situación Fiscal</strong> — leeremos exactamente qué obligaciones tiene asignadas tu empresa.</p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SummaryCard({ label, count, tone, icon: Icon }: { label: string; count: number; tone: "red" | "amber" | "jade" | "neutral"; icon: typeof CheckCircle2 }) {
  const c = {
    red: "bg-cos-red-tint text-cos-red-ink",
    amber: "bg-cos-amber-tint text-cos-amber-ink",
    jade: "bg-cos-jade-tint text-cos-jade-ink",
    neutral: "bg-cos-card text-cos-ink-soft border border-cos-line",
  }[tone];
  return (
    <div className={`rounded-card p-4 ${c}`}>
      <div className="mb-1 flex items-center gap-2"><Icon className="h-4 w-4" /><span className="text-[12.5px] font-medium">{label}</span></div>
      <p className="text-[28px] font-semibold tracking-[-0.02em]">{count}</p>
    </div>
  );
}

function ObligacionCard({ ob, onPeriodoClick }: { ob: ObligacionCalendar; onPeriodoClick: (p: string) => void }) {
  const counts = ob.periodos.reduce((acc, p) => { acc[p.estado] = (acc[p.estado] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  return (
    <Card className="overflow-hidden rounded-card border-cos-line shadow-card">
      <div className="flex items-center gap-3 border-b border-cos-line px-5 py-3.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-[15px] font-semibold text-cos-ink">{ob.descripcion}</h3>
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${ob.fuente === "CSF" ? "bg-cos-brand-tint text-cos-brand-ink" : "bg-cos-slate-tint text-cos-ink-soft"}`}>{ob.fuente === "CSF" ? "CSF" : "Régimen"}</span>
          </div>
          <p className="mt-0.5 text-[12px] capitalize text-cos-ink-faint">{ob.periodicidad.toLowerCase()} · {ob.tipo}</p>
        </div>
        <div className="ml-auto flex items-center gap-3 text-[12px]">
          {(counts.OVERDUE ?? 0) > 0 && <span className="flex items-center gap-1 font-medium text-cos-red-ink"><AlertTriangle className="h-3 w-3" />{counts.OVERDUE} vencida{counts.OVERDUE > 1 ? "s" : ""}</span>}
          {(counts.FILED ?? 0) > 0 && <span className="flex items-center gap-1 text-cos-jade-ink"><CheckCircle2 className="h-3 w-3" />{counts.FILED}</span>}
        </div>
      </div>
      <div className="px-5 py-4">
        {ob.periodicidad === "ANUAL" ? (
          ob.periodos.map((p) => <AnualRow key={p.periodo} p={p} onClick={() => onPeriodoClick(p.periodo)} />)
        ) : (
          <div className={`grid gap-2 ${ob.periodicidad === "BIMESTRAL" ? "grid-cols-6" : "grid-cols-6 sm:grid-cols-12"}`}>
            {ob.periodos.map((p) => <PeriodoCell key={p.periodo} p={p} onClick={() => onPeriodoClick(p.periodo)} />)}
          </div>
        )}
      </div>
    </Card>
  );
}

function PeriodoCell({ p, onClick }: { p: PeriodoItem; onClick: () => void }) {
  const cfg = ESTADO[p.estado];
  const Icon = cfg.icon;
  return (
    <button
      onClick={onClick}
      title={`${p.label} — ${cfg.chip ?? "N/A"}\nVence: ${fmtShort(p.vencimiento)}`}
      className={`flex flex-col items-center gap-1 rounded-[10px] border p-2 text-center transition-opacity hover:opacity-80 ${cfg.cell}`}
    >
      <span className={`text-[12px] font-medium ${cfg.text}`}>{p.label.split(" ")[0]}</span>
      {Icon && <Icon className={`h-3.5 w-3.5 ${cfg.text}`} />}
      <span className={`text-[11px] opacity-70 ${cfg.text}`}>{fmtShort(p.vencimiento)}</span>
    </button>
  );
}

function AnualRow({ p, onClick }: { p: PeriodoItem; onClick: () => void }) {
  const cfg = ESTADO[p.estado];
  const Icon = cfg.icon ?? Clock;
  return (
    <button onClick={onClick} className={`flex w-full items-center justify-between rounded-[10px] border px-4 py-3 transition-opacity hover:opacity-80 ${cfg.cell}`}>
      <div className="flex items-center gap-2"><Icon className={`h-4 w-4 ${cfg.text}`} /><span className={`text-sm font-medium ${cfg.text}`}>{p.label}</span></div>
      <div className="text-right">
        {cfg.chip ? <Chip status={cfg.chip} /> : <span className="text-[13px] text-cos-ink-faint">N/A</span>}
        <p className={`mt-0.5 text-[11px] opacity-70 ${cfg.text}`}>Vence {fmtShort(p.vencimiento)}</p>
      </div>
    </button>
  );
}

// ── Cobertura de datos fiscales (chequeo time-aware de frescura) ──────────────
interface CoberturaDataset {
  clave: string; nombre: string; estado: "al_dia" | "por_publicar" | "faltante" | "sin_cotejar";
  ultimoCargado: string | null; ultimoEsperado: string; detalle: string;
}
function CoberturaFiscalCard() {
  const [data, setData] = useState<{
    datasets: CoberturaDataset[];
    resumen: { faltantes: number; sinCotejar: number };
    inpcUltimo: { periodo: string; valor: number } | null;
    tipoCambioFix: { fecha: string; valor: number } | null;
  } | null>(null);
  useEffect(() => {
    fetch("/api/fiscal/cobertura").then((r) => (r.ok ? r.json() : null)).then(setData).catch(() => {});
  }, []);
  if (!data) return null;
  // Sólo mostramos lo accionable: faltante o sin cotejar. Si todo al día, una línea.
  const alertas = data.datasets.filter((d) => d.estado === "faltante" || d.estado === "sin_cotejar");

  return (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-[15px] font-semibold text-cos-ink">Datos fiscales (tarifas, INPC, UMA…)</h3>
      </div>
      <p className="mb-3 text-[12.5px] text-cos-ink-soft">
        Frescura de las tablas versionadas contra su calendario de publicación, al día de hoy.
      </p>
      {alertas.length === 0 ? (
        <p className="text-[13px] text-cos-jade-ink">✓ Todo al día y cotejado.</p>
      ) : (
        <ul className="space-y-1.5">
          {alertas.map((d) => (
            <li key={d.clave} className="flex items-start gap-2 text-[13px]">
              <span className={`mt-0.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                d.estado === "faltante" ? "bg-cos-red-tint text-cos-red-ink" : "bg-cos-amber-tint text-cos-amber-ink"
              }`}>
                {d.estado === "faltante" ? "Falta" : "Sin cotejar"}
              </span>
              <span className="text-cos-ink-soft"><b className="text-cos-ink">{d.nombre}</b> — {d.detalle}</span>
            </li>
          ))}
        </ul>
      )}
      {(data.inpcUltimo || data.tipoCambioFix) && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-cos-line pt-3 text-[12px] text-cos-ink-soft">
          {data.inpcUltimo && (
            <span>
              INPC {data.inpcUltimo.periodo}: <b className="text-cos-ink">{data.inpcUltimo.valor.toFixed(3)}</b>
            </span>
          )}
          {data.tipoCambioFix && (
            <span>
              FIX {data.tipoCambioFix.fecha}:{" "}
              <b className="text-cos-ink">${data.tipoCambioFix.valor.toFixed(4)}</b>
              <span className="text-cos-ink-soft"> /USD (Banxico)</span>
            </span>
          )}
        </div>
      )}
    </Card>
  );
}
