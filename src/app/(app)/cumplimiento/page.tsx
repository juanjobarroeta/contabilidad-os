"use client";

import { useEffect, useState, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { useRouter } from "next/navigation";
import {
  ChevronLeft, ChevronRight, CheckCircle2, AlertCircle,
  Clock, Loader2, RefreshCw, Upload, FileCheck, Info,
  CalendarDays,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────
type Estado = "FILED" | "PENDING" | "OVERDUE" | "UPCOMING" | "NOT_APPLICABLE";

interface PeriodoItem {
  periodo: string;
  label: string;
  vencimiento: string;
  estado: Estado;
  declaracionStatus: string | null;
}
interface ObligacionCalendar {
  tipo: string;
  descripcion: string;
  periodicidad: string;
  fuente: string;
  periodos: PeriodoItem[];
}
interface CalendarData {
  year: number;
  obligaciones: ObligacionCalendar[];
}

// ── Status display ─────────────────────────────────────────────────────────────
const ESTADO_CONFIG: Record<Estado, { label: string; bg: string; text: string; dot: string; icon: typeof CheckCircle2 }> = {
  FILED:           { label: "Presentada",  bg: "bg-green-50",  text: "text-green-700",  dot: "bg-green-500",  icon: CheckCircle2 },
  PENDING:         { label: "Pendiente",   bg: "bg-gray-50",   text: "text-gray-500",   dot: "bg-gray-300",   icon: Clock },
  OVERDUE:         { label: "Vencida",     bg: "bg-red-50",    text: "text-red-700",    dot: "bg-red-500",    icon: AlertCircle },
  UPCOMING:        { label: "Por vencer",  bg: "bg-amber-50",  text: "text-amber-700",  dot: "bg-amber-400",  icon: Clock },
  NOT_APPLICABLE:  { label: "N/A",         bg: "bg-gray-50",   text: "text-gray-300",   dot: "bg-gray-100",   icon: Clock },
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatShortDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "short" });
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function CumplimientoPage() {
  const { activeCompany } = useCompany();
  const router = useRouter();
  const [year, setYear] = useState(new Date().getFullYear());
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState("");

  // CSF upload state
  const [uploading, setUploading] = useState(false);
  const [csfResult, setCsfResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/obligaciones?companyId=${activeCompany.id}&year=${year}`);
      if (!res.ok) throw new Error("Error al cargar");
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
    setUploading(true);
    setCsfResult(null);
    setError("");
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
      load(); // refresh calendar
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al procesar la CSF");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  // Summary counts
  const summary = data?.obligaciones.flatMap(o => o.periodos).reduce(
    (acc, p) => { acc[p.estado] = (acc[p.estado] ?? 0) + 1; return acc; },
    {} as Record<string, number>
  );

  const overdueCount  = summary?.OVERDUE ?? 0;
  const upcomingCount = summary?.UPCOMING ?? 0;
  const filedCount    = summary?.FILED ?? 0;

  if (!activeCompany) return (
    <div className="p-8 text-muted-foreground text-sm">Selecciona una empresa para ver su calendario fiscal.</div>
  );

  return (
    <div className="p-6 max-w-5xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Cumplimiento Fiscal</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{activeCompany.razonSocial}</p>
        </div>

        {/* CSF upload */}
        <label className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border cursor-pointer transition-colors ${
          uploading
            ? "opacity-50 pointer-events-none border-border bg-gray-50 text-muted-foreground"
            : "border-border hover:bg-accent text-foreground"
        }`}>
          {uploading
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <Upload className="h-4 w-4" />}
          {uploading ? "Procesando CSF..." : "Subir CSF"}
          <input
            type="file" accept=".pdf" className="hidden"
            onChange={handleCsfUpload} disabled={uploading}
          />
        </label>
      </div>

      {/* Year selector */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => setYear(y => y - 1)} className="p-1.5 rounded-md border border-border hover:bg-accent transition-colors">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-lg font-semibold min-w-[80px] text-center">{year}</span>
        <button onClick={() => setYear(y => y + 1)} className="p-1.5 rounded-md border border-border hover:bg-accent transition-colors">
          <ChevronRight className="h-4 w-4" />
        </button>
        <button onClick={load} disabled={loading}
          className="ml-2 p-1.5 rounded-md border border-border hover:bg-accent transition-colors disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {/* Messages */}
      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-4">
          <AlertCircle className="h-4 w-4 shrink-0" />{error}
        </div>
      )}
      {csfResult && (
        <div className="flex items-start gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-700 mb-4">
          <FileCheck className="h-4 w-4 shrink-0 mt-0.5" />{csfResult}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-12 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" />Cargando calendario...
        </div>
      ) : data ? (
        <div className="space-y-5">

          {/* ── Summary cards ── */}
          <div className="grid grid-cols-3 gap-4">
            <SummaryCard
              label="Obligaciones vencidas"
              count={overdueCount}
              color={overdueCount > 0 ? "red" : "gray"}
              icon={AlertCircle}
            />
            <SummaryCard
              label="Por vencer (30 días)"
              count={upcomingCount}
              color={upcomingCount > 0 ? "amber" : "gray"}
              icon={Clock}
            />
            <SummaryCard
              label="Presentadas este año"
              count={filedCount}
              color="green"
              icon={CheckCircle2}
            />
          </div>

          {/* ── No obligations ── */}
          {data.obligaciones.length === 0 && (
            <div className="bg-white rounded-xl border border-border shadow-sm p-10 text-center">
              <CalendarDays className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-30" />
              <p className="font-medium text-sm">Sin obligaciones registradas</p>
              <p className="text-xs text-muted-foreground mt-1">
                Sube tu CSF para que el sistema detecte automáticamente tus obligaciones fiscales.
              </p>
            </div>
          )}

          {/* ── Calendar per obligation ── */}
          {data.obligaciones.map(ob => (
            <ObligacionCalendarCard
              key={ob.tipo}
              ob={ob}
              year={year}
              onPeriodoClick={(periodo) => {
                // Navigate to impuestos page for the period
                const [y, m] = periodo.includes("-B") || !periodo.includes("-")
                  ? [year, null]
                  : periodo.split("-");
                if (m) {
                  router.push(`/impuestos?month=${parseInt(m as string)}&year=${parseInt(y as string)}`);
                }
              }}
            />
          ))}

          {/* ── CSF info box ── */}
          <div className="flex items-start gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-700">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium mb-0.5">¿Cómo funciona?</p>
              <p>Las obligaciones se generan automáticamente según tu régimen fiscal (<strong>{activeCompany.regimenFiscal}</strong>).
              Para mayor precisión, sube tu <strong>Constancia de Situación Fiscal</strong> (CSF) del SAT —
              el sistema leerá exactamente qué obligaciones tiene asignadas tu empresa.</p>
            </div>
          </div>

        </div>
      ) : null}
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────
function SummaryCard({
  label, count, color, icon: Icon,
}: {
  label: string; count: number;
  color: "red" | "amber" | "green" | "gray";
  icon: typeof CheckCircle2;
}) {
  const colors = {
    red:   "bg-red-50 border-red-200",
    amber: "bg-amber-50 border-amber-200",
    green: "bg-green-50 border-green-200",
    gray:  "bg-gray-50 border-border",
  };
  const textColors = {
    red: "text-red-700", amber: "text-amber-700", green: "text-green-700", gray: "text-muted-foreground",
  };
  return (
    <div className={`rounded-xl border ${colors[color]} p-4`}>
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`h-4 w-4 ${textColors[color]}`} />
        <span className={`text-xs font-medium ${textColors[color]}`}>{label}</span>
      </div>
      <p className={`text-2xl font-bold ${textColors[color]}`}>{count}</p>
    </div>
  );
}

function ObligacionCalendarCard({
  ob, year, onPeriodoClick,
}: {
  ob: ObligacionCalendar;
  year: number;
  onPeriodoClick: (periodo: string) => void;
}) {
  const fuenteBadge = ob.fuente === "CSF"
    ? <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">CSF</span>
    : <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-500">Régimen</span>;

  // Count statuses
  const counts = ob.periodos.reduce((acc, p) => { acc[p.estado] = (acc[p.estado] ?? 0) + 1; return acc; }, {} as Record<string, number>);

  return (
    <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex items-center gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-sm">{ob.descripcion}</h3>
            {fuenteBadge}
          </div>
          <p className="text-xs text-muted-foreground capitalize">{ob.periodicidad.toLowerCase()} · {ob.tipo}</p>
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {(counts.OVERDUE ?? 0) > 0 && (
            <span className="flex items-center gap-1 text-red-600 font-medium">
              <AlertCircle className="h-3 w-3" />{counts.OVERDUE} vencida{counts.OVERDUE > 1 ? "s" : ""}
            </span>
          )}
          {(counts.FILED ?? 0) > 0 && (
            <span className="flex items-center gap-1 text-green-600">
              <CheckCircle2 className="h-3 w-3" />{counts.FILED} presentada{counts.FILED > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      <div className="px-5 py-4">
        {ob.periodicidad === "ANUAL" ? (
          // Annual: single big status card
          ob.periodos.map(p => (
            <AnualCard key={p.periodo} p={p} onClick={() => onPeriodoClick(p.periodo)} />
          ))
        ) : (
          // Monthly/bimonthly: grid of cells
          <div className={`grid gap-2 ${ob.periodicidad === "BIMESTRAL" ? "grid-cols-6" : "grid-cols-6 sm:grid-cols-12"}`}>
            {ob.periodos.map(p => (
              <PeriodoCell key={p.periodo} p={p} onClick={() => onPeriodoClick(p.periodo)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PeriodoCell({ p, onClick }: { p: PeriodoItem; onClick: () => void }) {
  const cfg = ESTADO_CONFIG[p.estado];
  const Icon = cfg.icon;
  return (
    <button
      onClick={onClick}
      title={`${p.label} — ${cfg.label}\nVence: ${formatShortDate(p.vencimiento)}`}
      className={`${cfg.bg} rounded-lg p-2 text-center flex flex-col items-center gap-1 hover:opacity-80 transition-opacity cursor-pointer border ${
        p.estado === "OVERDUE" ? "border-red-200" :
        p.estado === "UPCOMING" ? "border-amber-200" :
        p.estado === "FILED" ? "border-green-200" : "border-transparent"
      }`}
    >
      <span className={`text-xs font-medium ${cfg.text}`}>{p.label.split(" ")[0]}</span>
      <Icon className={`h-3.5 w-3.5 ${cfg.text}`} />
      <span className={`text-xs ${cfg.text} opacity-70`}>{formatShortDate(p.vencimiento)}</span>
    </button>
  );
}

function AnualCard({ p, onClick }: { p: PeriodoItem; onClick: () => void }) {
  const cfg = ESTADO_CONFIG[p.estado];
  const Icon = cfg.icon;
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between ${cfg.bg} rounded-lg px-4 py-3 border ${
        p.estado === "OVERDUE" ? "border-red-200" :
        p.estado === "UPCOMING" ? "border-amber-200" :
        p.estado === "FILED" ? "border-green-200" : "border-transparent"
      } hover:opacity-80 transition-opacity cursor-pointer`}
    >
      <div className="flex items-center gap-2">
        <Icon className={`h-4 w-4 ${cfg.text}`} />
        <span className={`text-sm font-medium ${cfg.text}`}>{p.label}</span>
      </div>
      <div className="text-right">
        <p className={`text-sm font-semibold ${cfg.text}`}>{cfg.label}</p>
        <p className={`text-xs ${cfg.text} opacity-70`}>Vence {formatShortDate(p.vencimiento)}</p>
      </div>
    </button>
  );
}
