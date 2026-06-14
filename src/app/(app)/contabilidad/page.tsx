"use client";

import { useCallback, useEffect, useState } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency } from "@/lib/utils";
import {
  Calendar, CheckCircle2, AlertCircle, Loader2, X,
  RotateCcw, FileText, BookOpen, Download, ArrowLeftRight,
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

interface SaldoRow {
  companyId: string;
  rfc: string;
  razonSocial: string;
  prestamosOtorgados: number;
  prestamosPorPagar: number;
  neto: number;
}

type TabId = "periods" | "balanza" | "estado" | "saldos";

export default function ContabilidadPage() {
  const { activeCompany } = useCompany();
  const [tab, setTab] = useState<TabId>("periods");
  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [posting, setPosting] = useState<string | null>(null);
  const [info, setInfo] = useState("");
  const [cierreLoading, setCierreLoading] = useState(false);

  async function handleCierre() {
    if (!activeCompany) return;
    setCierreLoading(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/contabilidad/cierre", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, year: selectedYear }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al generar el cierre");
      const r = data.resultado as number;
      setInfo(
        `Cierre ${selectedYear} generado (mes 13): ${r >= 0 ? "utilidad" : "pérdida"} de $${Math.abs(r).toLocaleString("es-MX", { minimumFractionDigits: 2 })}.`,
      );
      await loadPeriods();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al generar el cierre");
    } finally {
      setCierreLoading(false);
    }
  }

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
      <div className="p-8 text-cos-ink-soft text-sm">
        Selecciona una empresa para ver su contabilidad.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-7">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">Contabilidad</h1>
          <p className="mt-1.5 text-[15px] text-cos-ink-soft">{activeCompany.razonSocial}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href="/contabilidad/apertura"
            className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-white px-3 py-2 text-sm font-medium text-cos-ink hover:bg-cos-paper"
          >
            Saldos iniciales
          </a>
          <a
            href="/contabilidad/polizas"
            className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-white px-3 py-2 text-sm font-medium text-cos-ink hover:bg-cos-paper"
          >
            Pólizas
          </a>
          <button
            onClick={handleCierre}
            disabled={cierreLoading}
            title={`Generar el asiento de cierre del ejercicio ${selectedYear} (mes 13)`}
            className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-white px-3 py-2 text-sm font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
          >
            {cierreLoading ? "Generando…" : `Cierre ${selectedYear}`}
          </button>
          <a
            href={`/api/contabilidad/coe/balanza?companyId=${activeCompany.id}&year=${selectedYear}&month=13`}
            className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-white px-3 py-2 text-sm font-medium text-cos-ink hover:bg-cos-paper"
            title="Descargar la balanza de cierre (mes 13)"
          >
            XML Balanza 13
          </a>
        </div>
      </div>
      {info && (
        <div className="mb-4 flex items-center gap-2 rounded-card bg-cos-jade-tint px-4 py-3 text-sm text-cos-jade-ink">
          {info}
        </div>
      )}

      {error && (
        <div className={`flex items-center gap-2 rounded-card px-4 py-3 text-sm mb-4 ${
          error.startsWith("✓")
            ? "bg-cos-jade-tint border border-[oklch(0.66_0.12_168_/_0.28)] text-cos-jade-ink"
            : "bg-cos-red-tint border border-[oklch(0.6_0.2_25_/_0.22)] text-cos-red-ink"
        }`}>
          {error.startsWith("✓") ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="border-b border-cos-line mb-5">
        <div className="flex gap-1">
          {([
            ["periods", "Cierres mensuales", Calendar],
            ["balanza", "Balanza de comprobación", BookOpen],
            ["estado",  "Estado de resultados", FileText],
            ["saldos",  "Saldos interempresa", ArrowLeftRight],
          ] as const).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id as TabId)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === id
                  ? "border-cos-brand text-cos-brand-ink"
                  : "border-transparent text-cos-ink-soft hover:text-cos-ink"
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

      {tab === "saldos" && (
        <SaldosInterempresaPanel companyId={activeCompany.id} />
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
      <div className="flex items-center gap-2 text-cos-ink-soft text-sm py-12 justify-center">
        <Loader2 className="h-5 w-5 animate-spin" /> Cargando periodos...
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => setYear(y => y - 1)}
          className="text-sm px-3 py-1.5 border border-cos-line rounded-md hover:bg-cos-paper"
        >
          ←
        </button>
        <h2 className="text-lg font-semibold flex-1">{year}</h2>
        <button
          onClick={() => setYear(y => y + 1)}
          className="text-sm px-3 py-1.5 border border-cos-line rounded-md hover:bg-cos-paper"
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
                isPosted ? "border-[oklch(0.66_0.12_168_/_0.35)] bg-cos-jade-tint" : "border-cos-line"
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="font-semibold">{MESES[month - 1]}</p>
                  <p className="text-xs text-cos-ink-soft">{year}</p>
                </div>
                {isPosted && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-cos-jade-ink bg-cos-jade-tint px-2 py-0.5 rounded">
                    <CheckCircle2 className="h-3 w-3" /> Cerrado
                  </span>
                )}
              </div>

              {period && isPosted ? (
                <>
                  <div className="text-xs text-cos-ink-soft space-y-1 mb-3">
                    <div className="flex justify-between">
                      <span>Asientos</span>
                      <span className="font-medium text-cos-ink">{period.entriesCount}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Cargos</span>
                      <span className="font-medium text-cos-ink">{formatCurrency(period.totalCargos)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Abonos</span>
                      <span className="font-medium text-cos-ink">{formatCurrency(period.totalAbonos)}</span>
                    </div>
                  </div>
                  <div className="flex gap-2 mb-2">
                    <button
                      onClick={() => onSelect(year, month)}
                      className="flex-1 text-xs border border-cos-line rounded-md py-1.5 hover:bg-cos-paper"
                    >
                      Ver balanza
                    </button>
                    <button
                      onClick={() => onUnpost(year, month)}
                      disabled={isPosting}
                      className="text-xs text-cos-ink-soft hover:text-cos-ink px-2 py-1.5 disabled:opacity-50"
                      title="Reabrir periodo"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="flex gap-1.5">
                    <a
                      href={`/api/contabilidad/coe/catalogo?companyId=${companyId}&year=${year}&month=${month}`}
                      className="flex-1 flex items-center justify-center gap-1 text-[10px] bg-cos-slate-tint hover:bg-cos-line rounded py-1"
                      title="Descargar XML Catálogo de Cuentas"
                    >
                      <Download className="h-3 w-3" /> XML Catálogo
                    </a>
                    <a
                      href={`/api/contabilidad/coe/balanza?companyId=${companyId}&year=${year}&month=${month}`}
                      className="flex-1 flex items-center justify-center gap-1 text-[10px] bg-cos-slate-tint hover:bg-cos-line rounded py-1"
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
                  className="w-full bg-cos-brand text-white rounded-md py-2 text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50 flex items-center justify-center gap-2"
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
        className="text-sm border border-cos-line rounded-md px-2 py-1.5 bg-white"
      >
        {MESES.map((m, i) => (
          <option key={i} value={i + 1}>{m}</option>
        ))}
      </select>
      <input
        type="number"
        value={year}
        onChange={(e) => onChange(parseInt(e.target.value), month)}
        className="w-24 text-sm border border-cos-line rounded-md px-2 py-1.5 bg-white"
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
        <div className="flex items-center gap-2 text-sm text-cos-ink-soft py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : nonZero.length === 0 ? (
        <div className="bg-white border border-dashed border-cos-line rounded-xl p-12 text-center">
          <BookOpen className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
          <p className="text-sm text-cos-ink-soft">Sin movimientos para este periodo.</p>
          <p className="text-xs text-cos-ink-soft mt-1">Cierra el mes desde la pestaña &ldquo;Cierres mensuales&rdquo;.</p>
        </div>
      ) : (
        <div className="bg-white border border-cos-line rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cos-line bg-cos-paper">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Cuenta</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Nombre</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Cargos</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Abonos</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {nonZero.map((r, i) => (
                <tr key={`${r.cuentaSAT}-${r.subcuenta}-${i}`} className="border-b border-cos-line last:border-0 hover:bg-cos-paper/50">
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
        <div className="flex items-center gap-2 text-sm text-cos-ink-soft py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : !data || (data.ingresos.length === 0 && data.gastos.length === 0) ? (
        <div className="bg-white border border-dashed border-cos-line rounded-xl p-12 text-center">
          <FileText className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
          <p className="text-sm text-cos-ink-soft">Sin movimientos para este periodo.</p>
        </div>
      ) : (
        <div className="bg-white border border-cos-line rounded-xl p-6 space-y-5 text-sm">
          <Section label="Ingresos" rows={data.ingresos} total={data.totalIngresos} positive />
          {data.costos.length > 0 && (
            <Section label="Costos" rows={data.costos} total={data.totalCostos} positive={false} />
          )}
          <Section label="Gastos" rows={data.gastos} total={data.totalGastos} positive={false} />

          <div className="border-t-2 border-cos-line pt-4 space-y-2">
            {data.costos.length > 0 && (
              <div className="flex items-center justify-between font-medium">
                <span>Utilidad bruta</span>
                <span className={data.utilidadBruta >= 0 ? "text-cos-jade-ink" : "text-cos-red-ink"}>
                  {formatCurrency(data.utilidadBruta)}
                </span>
              </div>
            )}
            <div className="flex items-center justify-between text-base font-bold">
              <span>Utilidad antes de impuestos</span>
              <span className={data.utilidadAntesImpuestos >= 0 ? "text-cos-jade-ink" : "text-cos-red-ink"}>
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
      <p className="font-semibold text-xs uppercase tracking-wide text-cos-ink-soft mb-2">{label}</p>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={`${r.cuentaSAT}-${r.subcuenta}`} className="flex items-center justify-between text-sm">
            <span className="text-cos-ink-soft">{r.nombre}</span>
            <span className="font-mono">{formatCurrency(r.monto)}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-cos-line mt-2 pt-2 font-medium">
        <span>Total {label.toLowerCase()}</span>
        <span className={`font-mono ${positive ? "text-cos-jade-ink" : "text-cos-red-ink"}`}>
          {formatCurrency(total)}
        </span>
      </div>
    </div>
  );
}

function SaldosInterempresaPanel({ companyId }: { companyId: string }) {
  const [rows, setRows] = useState<SaldoRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/contabilidad/saldos-interempresa?companyId=${companyId}`);
        const data = await res.json();
        setRows(data.rows ?? []);
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  const totalOtorgados = rows.reduce((s, r) => s + r.prestamosOtorgados, 0);
  const totalPorPagar = rows.reduce((s, r) => s + r.prestamosPorPagar, 0);
  const hasActivity = rows.some((r) => Math.abs(r.neto) > 0.01);

  return (
    <div>
      <p className="text-xs text-cos-ink-soft mb-4">
        Posición neta de préstamos entre todas las empresas del despacho.
        Saldo positivo = prestamista neto, negativo = deudor neto.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-cos-ink-soft py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : !hasActivity ? (
        <div className="bg-white border border-dashed border-cos-line rounded-xl p-12 text-center">
          <ArrowLeftRight className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
          <p className="text-sm text-cos-ink-soft">Sin préstamos interempresa registrados.</p>
          <p className="text-xs text-cos-ink-soft mt-1">
            Los préstamos aparecen cuando clasificas transacciones bancarias como
            &ldquo;Préstamo otorgado&rdquo; o &ldquo;Préstamo recibido&rdquo; y cierras el mes.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-cos-line rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cos-line bg-cos-paper">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Empresa</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">RFC</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Otorgados</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Por pagar</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Neto</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.companyId} className="border-b border-cos-line last:border-0 hover:bg-cos-paper/50">
                  <td className="px-4 py-2.5 font-medium">{r.razonSocial}</td>
                  <td className="px-4 py-2.5 text-xs font-mono text-cos-ink-soft">{r.rfc}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">
                    {r.prestamosOtorgados > 0 ? formatCurrency(r.prestamosOtorgados) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">
                    {r.prestamosPorPagar > 0 ? formatCurrency(r.prestamosPorPagar) : "—"}
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono text-xs font-semibold ${
                    r.neto > 0 ? "text-cos-jade-ink" : r.neto < 0 ? "text-cos-red-ink" : ""
                  }`}>
                    {Math.abs(r.neto) < 0.01 ? "—" : formatCurrency(r.neto)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-cos-paper font-semibold">
                <td className="px-4 py-2.5" colSpan={2}>Total despacho</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs">{formatCurrency(totalOtorgados)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs">{formatCurrency(totalPorPagar)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs font-bold">
                  {formatCurrency(totalOtorgados - totalPorPagar)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
