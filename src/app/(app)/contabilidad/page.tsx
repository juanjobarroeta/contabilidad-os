"use client";

import { useCallback, useEffect, useState } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency } from "@/lib/utils";
import {
  Calendar, CheckCircle2, AlertCircle, Loader2, X,
  RotateCcw, FileText, BookOpen, Download,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────
type PeriodStatus = "DRAFT" | "POSTED" | "CLOSED";
interface Period {
  id: string;
  year: number;
  month: number;
  status: PeriodStatus;
  postedAt: string | null;
  entriesCount: number;
  totalCargos: number;
  totalAbonos: number;
}
interface BalanzaRow {
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  tipo: "ACTIVO" | "PASIVO" | "CAPITAL" | "INGRESO" | "GASTO" | "COSTO";
  nivel: number;
  cargos: number;
  abonos: number;
  saldo: number;
}
interface EstadoResultadosRow {
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  monto: number;
}
interface EstadoResultados {
  ingresos: EstadoResultadosRow[];
  costos: EstadoResultadosRow[];
  gastos: EstadoResultadosRow[];
  totalIngresos: number;
  totalCostos: number;
  totalGastos: number;
  utilidadBruta: number;
  utilidadAntesImpuestos: number;
}

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

type TabId = "periods" | "balanza" | "estado";

export default function ContabilidadPage() {
  const { activeCompany } = useCompany();
  const [tab, setTab] = useState<TabId>("periods");
  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [posting, setPosting] = useState<string | null>(null);

  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);

  const loadPeriods = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/contabilidad/periods?companyId=${activeCompany.id}`);
      const data = await res.json();
      setPeriods(Array.isArray(data) ? data : []);
    } catch {
      setError("Error al cargar periodos");
    } finally {
      setLoading(false);
    }
  }, [activeCompany]);

  useEffect(() => { loadPeriods(); }, [loadPeriods]);

  async function handlePost(year: number, month: number) {
    if (!activeCompany) return;
    const key = `${year}-${month}`;
    setPosting(key);
    setError("");
    try {
      const res = await fetch(`/api/contabilidad/post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, year, month }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al cerrar el mes");
      await loadPeriods();
      setSelectedYear(year);
      setSelectedMonth(month);
      const warn = data.warnings?.length ?? 0;
      setError(
        `✓ ${data.entriesCreated} asientos creados${warn > 0 ? ` · ${warn} advertencia(s)` : ""}`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setPosting(null);
    }
  }

  async function handleUnpost(year: number, month: number) {
    if (!activeCompany) return;
    if (!confirm(`¿Reabrir ${MESES[month - 1]} ${year}? Se eliminarán todos los asientos del periodo.`)) return;
    const key = `${year}-${month}`;
    setPosting(key);
    try {
      await fetch(
        `/api/contabilidad/post?companyId=${activeCompany.id}&year=${year}&month=${month}`,
        { method: "DELETE" }
      );
      await loadPeriods();
    } finally {
      setPosting(null);
    }
  }

  if (!activeCompany) {
    return (
      <div className="p-8 text-muted-foreground text-sm">
        Selecciona una empresa para ver su contabilidad.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Contabilidad</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{activeCompany.razonSocial}</p>
      </div>

      {error && (
        <div className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm mb-4 ${
          error.startsWith("✓")
            ? "bg-green-50 border border-green-200 text-green-700"
            : "bg-red-50 border border-red-200 text-red-700"
        }`}>
          {error.startsWith("✓") ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="border-b border-border mb-5">
        <div className="flex gap-1">
          {([
            ["periods", "Cierres mensuales", Calendar],
            ["balanza", "Balanza de comprobación", BookOpen],
            ["estado",  "Estado de resultados", FileText],
          ] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id as TabId)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>
      </div>

      {tab === "periods" && activeCompany && (
        <PeriodsPanel
          companyId={activeCompany.id}
          loading={loading}
          periods={periods}
          posting={posting}
          currentYear={now.getFullYear()}
          onPost={handlePost}
          onUnpost={handleUnpost}
          onSelect={(y, m) => { setSelectedYear(y); setSelectedMonth(m); setTab("balanza"); }}
        />
      )}

      {tab === "balanza" && (
        <BalanzaPanel
          companyId={activeCompany.id}
          year={selectedYear}
          month={selectedMonth}
          onChangePeriod={(y, m) => { setSelectedYear(y); setSelectedMonth(m); }}
        />
      )}

      {tab === "estado" && (
        <EstadoResultadosPanel
          companyId={activeCompany.id}
          year={selectedYear}
          month={selectedMonth}
          onChangePeriod={(y, m) => { setSelectedYear(y); setSelectedMonth(m); }}
        />
      )}
    </div>
  );
}

function PeriodsPanel({
  companyId, loading, periods, posting, currentYear, onPost, onUnpost, onSelect,
}: {
  companyId: string;
  loading: boolean;
  periods: Period[];
  posting: string | null;
  currentYear: number;
  onPost: (year: number, month: number) => void;
  onUnpost: (year: number, month: number) => void;
  onSelect: (year: number, month: number) => void;
}) {
  const [year, setYear] = useState(currentYear);

  const byKey = new Map(periods.map(p => [`${p.year}-${p.month}`, p]));
  const months = Array.from({ length: 12 }, (_, i) => i + 1);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm py-12 justify-center">
        <Loader2 className="h-5 w-5 animate-spin" /> Cargando periodos...
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => setYear(y => y - 1)}
          className="text-sm px-3 py-1.5 border border-border rounded-md hover:bg-accent"
        >
          ←
        </button>
        <h2 className="text-lg font-semibold flex-1">{year}</h2>
        <button
          onClick={() => setYear(y => y + 1)}
          className="text-sm px-3 py-1.5 border border-border rounded-md hover:bg-accent"
        >
          →
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {months.map(month => {
          const key = `${year}-${month}`;
          const period = byKey.get(key);
          const isPosting = posting === key;
          const isPosted = period?.status === "POSTED" || period?.status === "CLOSED";

          return (
            <div
              key={month}
              className={`bg-white border rounded-xl p-4 transition-colors ${
                isPosted ? "border-green-300 bg-green-50/30" : "border-border"
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="font-semibold">{MESES[month - 1]}</p>
                  <p className="text-xs text-muted-foreground">{year}</p>
                </div>
                {isPosted && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded">
                    <CheckCircle2 className="h-3 w-3" /> Cerrado
                  </span>
                )}
              </div>

              {period && isPosted ? (
                <>
                  <div className="text-xs text-muted-foreground space-y-1 mb-3">
                    <div className="flex justify-between">
                      <span>Asientos</span>
                      <span className="font-medium text-foreground">{period.entriesCount}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Cargos</span>
                      <span className="font-medium text-foreground">{formatCurrency(period.totalCargos)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Abonos</span>
                      <span className="font-medium text-foreground">{formatCurrency(period.totalAbonos)}</span>
                    </div>
                  </div>
                  <div className="flex gap-2 mb-2">
                    <button
                      onClick={() => onSelect(year, month)}
                      className="flex-1 text-xs border border-border rounded-md py-1.5 hover:bg-accent"
                    >
                      Ver balanza
                    </button>
                    <button
                      onClick={() => onUnpost(year, month)}
                      disabled={isPosting}
                      className="text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 disabled:opacity-50"
                      title="Reabrir periodo"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="flex gap-1.5">
                    <a
                      href={`/api/contabilidad/coe/catalogo?companyId=${companyId}&year=${year}&month=${month}`}
                      className="flex-1 flex items-center justify-center gap-1 text-[10px] bg-gray-100 hover:bg-gray-200 rounded py-1"
                      title="Descargar XML Catálogo de Cuentas"
                    >
                      <Download className="h-3 w-3" /> XML Catálogo
                    </a>
                    <a
                      href={`/api/contabilidad/coe/balanza?companyId=${companyId}&year=${year}&month=${month}`}
                      className="flex-1 flex items-center justify-center gap-1 text-[10px] bg-gray-100 hover:bg-gray-200 rounded py-1"
                      title="Descargar XML Balanza de Comprobación"
                    >
                      <Download className="h-3 w-3" /> XML Balanza
                    </a>
                  </div>
                </>
              ) : (
                <button
                  onClick={() => onPost(year, month)}
                  disabled={isPosting}
                  className="w-full bg-primary text-primary-foreground rounded-md py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {isPosting ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cerrando...
                    </>
                  ) : (
                    "Cerrar mes"
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PeriodPicker({
  year, month, onChange,
}: { year: number; month: number; onChange: (y: number, m: number) => void }) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <select
        value={month}
        onChange={(e) => onChange(year, parseInt(e.target.value))}
        className="text-sm border border-border rounded-md px-2 py-1.5 bg-white"
      >
        {MESES.map((m, i) => (
          <option key={i} value={i + 1}>{m}</option>
        ))}
      </select>
      <input
        type="number"
        value={year}
        onChange={(e) => onChange(parseInt(e.target.value), month)}
        className="w-24 text-sm border border-border rounded-md px-2 py-1.5 bg-white"
      />
    </div>
  );
}

function BalanzaPanel({
  companyId, year, month, onChangePeriod,
}: { companyId: string; year: number; month: number; onChangePeriod: (y: number, m: number) => void }) {
  const [rows, setRows] = useState<BalanzaRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(
        `/api/contabilidad/balanza?companyId=${companyId}&year=${year}&month=${month}`
      );
      const data = await res.json();
      setRows(data.rows ?? []);
      setLoading(false);
    })();
  }, [companyId, year, month]);

  const nonZero = rows.filter(r => Math.abs(r.cargos) > 0.01 || Math.abs(r.abonos) > 0.01);

  return (
    <div>
      <PeriodPicker year={year} month={month} onChange={onChangePeriod} />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : nonZero.length === 0 ? (
        <div className="bg-white border border-dashed border-border rounded-xl p-12 text-center">
          <BookOpen className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-30" />
          <p className="text-sm text-muted-foreground">Sin movimientos para este periodo.</p>
          <p className="text-xs text-muted-foreground mt-1">Cierra el mes desde la pestaña &ldquo;Cierres mensuales&rdquo;.</p>
        </div>
      ) : (
        <div className="bg-white border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-gray-50">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Cuenta</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Nombre</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Cargos</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Abonos</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {nonZero.map((r, i) => (
                <tr key={`${r.cuentaSAT}-${r.subcuenta}-${i}`} className="border-b border-border last:border-0 hover:bg-gray-50/50">
                  <td className="px-4 py-2 text-xs font-mono">{r.subcuenta ?? r.cuentaSAT}</td>
                  <td className="px-4 py-2">{r.nombre}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{r.cargos > 0 ? formatCurrency(r.cargos) : "—"}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{r.abonos > 0 ? formatCurrency(r.abonos) : "—"}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs font-semibold">{formatCurrency(r.saldo)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EstadoResultadosPanel({
  companyId, year, month, onChangePeriod,
}: { companyId: string; year: number; month: number; onChangePeriod: (y: number, m: number) => void }) {
  const [data, setData] = useState<EstadoResultados | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(
        `/api/contabilidad/estado-resultados?companyId=${companyId}&year=${year}&month=${month}`
      );
      const d = await res.json();
      setData(d);
      setLoading(false);
    })();
  }, [companyId, year, month]);

  return (
    <div>
      <PeriodPicker year={year} month={month} onChange={onChangePeriod} />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : !data || (data.ingresos.length === 0 && data.gastos.length === 0) ? (
        <div className="bg-white border border-dashed border-border rounded-xl p-12 text-center">
          <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-30" />
          <p className="text-sm text-muted-foreground">Sin movimientos para este periodo.</p>
        </div>
      ) : (
        <div className="bg-white border border-border rounded-xl p-6 space-y-5 text-sm">
          <Section label="Ingresos" rows={data.ingresos} total={data.totalIngresos} positive />
          {data.costos.length > 0 && (
            <Section label="Costos" rows={data.costos} total={data.totalCostos} positive={false} />
          )}
          <Section label="Gastos" rows={data.gastos} total={data.totalGastos} positive={false} />

          <div className="border-t-2 border-border pt-4 space-y-2">
            {data.costos.length > 0 && (
              <div className="flex items-center justify-between font-medium">
                <span>Utilidad bruta</span>
                <span className={data.utilidadBruta >= 0 ? "text-green-700" : "text-red-600"}>
                  {formatCurrency(data.utilidadBruta)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between text-base font-bold">
              <span>Utilidad antes de impuestos</span>
              <span className={data.utilidadAntesImpuestos >= 0 ? "text-green-700" : "text-red-600"}>
                {formatCurrency(data.utilidadAntesImpuestos)}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  label, rows, total, positive,
}: {
  label: string;
  rows: EstadoResultadosRow[];
  total: number;
  positive: boolean;
}) {
  return (
    <div>
      <p className="font-semibold text-xs uppercase tracking-wide text-muted-foreground mb-2">{label}</p>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={`${r.cuentaSAT}-${r.subcuenta}`} className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{r.nombre}</span>
            <span className="font-mono">{formatCurrency(r.monto)}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-border mt-2 pt-2 font-medium">
        <span>Total {label.toLowerCase()}</span>
        <span className={`font-mono ${positive ? "text-green-700" : "text-red-600"}`}>
          {formatCurrency(total)}
        </span>
      </div>
    </div>
  );
}
