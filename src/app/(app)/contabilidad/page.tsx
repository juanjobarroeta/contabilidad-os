"use client";

import { useCallback, useEffect, useState } from "react";
import { Money } from "@/components/ui";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency } from "@/lib/utils";
import {
  Calendar, CheckCircle2, AlertCircle, Loader2, X,
  RotateCcw, FileText, BookOpen, Download, ArrowLeftRight, Boxes,
  Landmark, FileCheck2, Clock, ExternalLink, ShieldCheck, ArrowRight,
  ScrollText, Scale,
} from "lucide-react";
import { ActivoFijoView } from "@/components/contabilidad/ActivoFijoView";
import { LibroDiarioPanel, BalanceGeneralPanel, AuxiliarCuentaModal } from "@/components/contabilidad/LibroPanels";
import { BotonExcel } from "@/components/contabilidad/BotonExcel";
import { ConciliacionBancariaPanel } from "@/components/contabilidad/ConciliacionBancariaPanel";
import { evaluarCierreEjercicio } from "@/lib/contabilidad/ejercicio";

// ── Readiness CE (tipos espejo de /api/contabilidad/ce-readiness) ──────────────
type ReadinessCheckEstado = "ok" | "warn" | "error";
type ReadinessStatus = "lista" | "con_huecos" | "incompleta";
interface ReadinessCheck {
  clave: string;
  estado: ReadinessCheckEstado;
  titulo: string;
  detalle: string;
  cta?: { label: string; href: string };
}
interface ReadinessResult {
  status: ReadinessStatus;
  resumen: string;
  checks: ReadinessCheck[];
}

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
  preliminar?: boolean;
}

function PreliminarBanner() {
  return (
    <div className="mb-4 flex items-start gap-2 rounded-card border border-cos-line bg-cos-slate-tint px-4 py-3 text-sm text-cos-ink">
      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-cos-ink-soft" />
      <span>
        <span className="font-medium">Preliminar</span> — el mes aún no se ha cerrado.
        Cálculo directo de tus CFDIs; cierra el mes para generar las pólizas.
      </span>
    </div>
  );
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

type TabId = "periods" | "coe" | "libro" | "balanza" | "conciliacion" | "estado" | "balance" | "saldos" | "activo-fijo";

const TAB_IDS: readonly TabId[] = ["periods", "coe", "libro", "balanza", "conciliacion", "estado", "balance", "saldos", "activo-fijo"];

export default function ContabilidadPage() {
  const { activeCompany } = useCompany();
  const [tab, setTab] = useState<TabId>("periods");

  // Honor deep-links (?tab=). Read la URL directamente para no forzar un
  // Suspense boundary (useSearchParams). La redirección de /activos llega aquí
  // con ?tab=activo-fijo.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && TAB_IDS.includes(t as TabId)) setTab(t as TabId);
  }, []);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [posting, setPosting] = useState<string | null>(null);
  const [info, setInfo] = useState("");
  const [cierreLoading, setCierreLoading] = useState(false);
  const [pendingLoading, setPendingLoading] = useState(false);

  async function handlePostPending(year: number) {
    if (!activeCompany) return;
    setPendingLoading(true);
    setError("");
    setInfo("");
    try {
      const res = await fetch("/api/contabilidad/post-pending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, year }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al actualizar los meses pendientes");
      const parts: string[] = [];
      parts.push(`${data.posted} mes(es) cerrado(s)`);
      if (data.errors?.length > 0) parts.push(`${data.errors.length} con error`);
      setInfo(`Meses pendientes ${year}: ${parts.join(" · ")}.`);
      await loadPeriods();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error al actualizar los meses pendientes");
    } finally {
      setPendingLoading(false);
    }
  }

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
            className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-2 text-sm font-medium text-cos-ink hover:bg-cos-paper"
          >
            Saldos iniciales
          </a>
          <a
            href="/contabilidad/polizas"
            className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-2 text-sm font-medium text-cos-ink hover:bg-cos-paper"
          >
            Pólizas
          </a>
          <button
            onClick={handleCierre}
            disabled={cierreLoading}
            title={`Generar el asiento de cierre del ejercicio ${selectedYear} (mes 13)`}
            className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-2 text-sm font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
          >
            {cierreLoading ? "Generando…" : `Cierre ${selectedYear}`}
          </button>
          <a
            href={`/api/contabilidad/coe/balanza?companyId=${activeCompany.id}&year=${selectedYear}&month=13`}
            className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-2 text-sm font-medium text-cos-ink hover:bg-cos-paper"
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
            ["coe", "Contabilidad Electrónica", Landmark],
            ["libro", "Libro diario", ScrollText],
            ["balanza", "Balanza", BookOpen],
            ["conciliacion", "Conciliación bancaria", Landmark],
            ["estado",  "Estado de resultados", FileText],
            ["balance", "Balance general", Scale],
            ["saldos",  "Saldos interempresa", ArrowLeftRight],
            ["activo-fijo", "Activo fijo", Boxes],
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
          onPostPending={handlePostPending}
          pendingLoading={pendingLoading}
          onReload={loadPeriods}
          onSelect={(y, m) => { setSelectedYear(y); setSelectedMonth(m); setTab("balanza"); }}
        />
      )}

      {tab === "coe" && (
        <ContabilidadElectronicaPanel
          companyId={activeCompany.id}
          periods={periods}
          year={selectedYear}
          month={selectedMonth}
          onChangePeriod={(y, m) => { setSelectedYear(y); setSelectedMonth(m); }}
        />
      )}

      {tab === "libro" && (
        <div>
          <PeriodPicker year={selectedYear} month={selectedMonth}
            onChange={(y, m) => { setSelectedYear(y); setSelectedMonth(m); }} />
          <LibroDiarioPanel companyId={activeCompany.id} year={selectedYear} month={selectedMonth} />
        </div>
      )}

      {tab === "balanza" && (
        <BalanzaPanel
          companyId={activeCompany.id}
          year={selectedYear}
          month={selectedMonth}
          onChangePeriod={(y, m) => { setSelectedYear(y); setSelectedMonth(m); }}
        />
      )}

      {tab === "balance" && (
        <div>
          <PeriodPicker year={selectedYear} month={selectedMonth}
            onChange={(y, m) => { setSelectedYear(y); setSelectedMonth(m); }} />
          <BalanceGeneralPanel companyId={activeCompany.id} year={selectedYear} month={selectedMonth} />
        </div>
      )}

      {tab === "conciliacion" && (
        <div>
          <PeriodPicker year={selectedYear} month={selectedMonth}
            onChange={(y, m) => { setSelectedYear(y); setSelectedMonth(m); }} />
          <ConciliacionBancariaPanel companyId={activeCompany.id} year={selectedYear} month={selectedMonth} />
        </div>
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

      {tab === "activo-fijo" && (
        <ActivoFijoView />
      )}
    </div>
  );
}

function PeriodsPanel({
  companyId, loading, periods, posting, currentYear, onPost, onUnpost, onPostPending, pendingLoading, onReload, onSelect,
}: {
  companyId: string;
  loading: boolean;
  periods: Period[];
  posting: string | null;
  currentYear: number;
  onPost: (year: number, month: number) => void;
  onUnpost: (year: number, month: number) => void;
  onPostPending: (year: number) => void;
  pendingLoading: boolean;
  onReload: () => void | Promise<void>;
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
        <button
          onClick={() => onPostPending(year)}
          disabled={pendingLoading}
          title="Cierra/actualiza los meses con CFDIs que aún están en borrador. No toca meses ya cerrados ni los que tengan ajustes manuales."
          className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-sm font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
        >
          {pendingLoading ? (
            <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Actualizando…</>
          ) : (
            "Cerrar/actualizar meses pendientes"
          )}
        </button>
      </div>

      <EjercicioCard companyId={companyId} year={year} periods={periods} onReload={onReload} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {months.map(month => {
          const key = `${year}-${month}`;
          const period = byKey.get(key);
          const isPosting = posting === key;
          const isPosted = period?.status === "POSTED" || period?.status === "CLOSED";

          return (
            <div
              key={month}
              className={`bg-cos-card border rounded-xl p-4 transition-colors ${
                isPosted ? "border-[oklch(0.66_0.12_168_/_0.35)] bg-cos-jade-tint" : "border-cos-line"
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="font-semibold">{MESES[month - 1]}</p>
                  <p className="text-xs text-cos-ink-soft">{year}</p>
                </div>
                {isPosted && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-cos-jade-ink bg-cos-jade-tint px-2 py-0.5 rounded"
                    title={period?.status === "CLOSED" ? "Ejercicio cerrado: el periodo ya no admite cambios" : undefined}>
                    {period?.status === "CLOSED"
                      ? <><ShieldCheck className="h-3 w-3" /> Protegido</>
                      : <><CheckCircle2 className="h-3 w-3" /> Cerrado</>}
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
                      <span className="font-medium text-cos-ink"><Money value={period.totalCargos} /></span>
                    </div>
                    <div className="flex justify-between">
                      <span>Abonos</span>
                      <span className="font-medium text-cos-ink"><Money value={period.totalAbonos} /></span>
                    </div>
                  </div>
                  <div className="flex gap-2 mb-2">
                    <button
                      onClick={() => onSelect(year, month)}
                      className="flex-1 text-xs border border-cos-line rounded-md py-1.5 hover:bg-cos-paper"
                    >
                      Ver balanza
                    </button>
                    {/* Con el ejercicio cerrado no se reabre un mes suelto: hay
                        que reabrir el ejercicio completo, que queda en bitácora. */}
                    {period.status !== "CLOSED" && (
                      <button
                        onClick={() => onUnpost(year, month)}
                        disabled={isPosting}
                        className="text-xs text-cos-ink-soft hover:text-cos-ink px-2 py-1.5 disabled:opacity-50"
                        title="Reabrir periodo"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    )}
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

// ── Candado de ejercicio (Fase 3.2) ──────────────────────────────────────────
// Cerrar el ejercicio es lo que convierte un año "ya declarado" en un año que
// el sistema PROTEGE: a partir de ahí ninguna ruta de escritura puede tocarlo
// (re-posteo, conciliación, pólizas manuales, módulos satélite). Antes de
// cerrar hay que traspasar el resultado a acumulados, o el año nuevo arrancaría
// con la utilidad del anterior todavía en 305.01.
function EjercicioCard({
  companyId, year, periods, onReload,
}: {
  companyId: string;
  year: number;
  periods: Period[];
  onReload: () => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<"cerrar" | "reabrir" | "traspaso" | null>(null);
  const [msg, setMsg] = useState<{ texto: string; error: boolean } | null>(null);

  const delAnio = periods.filter((p) => p.year === year);
  const ev = evaluarCierreEjercicio(delAnio);
  // El traspaso vive en el mes 1 del año siguiente, así que sólo tiene sentido
  // ofrecerlo cuando ya existe el asiento de cierre de este ejercicio.
  const puedeTraspasar = !ev.faltaCierre;

  async function accion(tipo: "cerrar" | "reabrir" | "traspaso") {
    if (tipo === "cerrar" && !confirm(
      `¿Cerrar el ejercicio ${year}? A partir de ese momento ningún proceso podrá modificar sus asientos: ni el re-posteo automático, ni la conciliación bancaria, ni las pólizas manuales. Siempre puedes reabrirlo (queda registrado en la bitácora).`
    )) return;
    if (tipo === "reabrir" && !confirm(
      `¿Reabrir el ejercicio ${year}? Los periodos vuelven a admitir cambios. La acción queda registrada en la bitácora.`
    )) return;

    setBusy(tipo);
    setMsg(null);
    try {
      const url = tipo === "traspaso" ? "/api/contabilidad/traspaso" : "/api/contabilidad/ejercicio";
      const body = tipo === "traspaso"
        ? { companyId, year }
        : { companyId, year, accion: tipo };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "No se pudo completar la operación");

      if (tipo === "traspaso") {
        const r = data.resultado as number;
        setMsg({
          texto: r === 0
            ? `El ejercicio ${year} cerró en ceros: no hay resultado que traspasar.`
            : `Traspasado a resultados acumulados: ${r >= 0 ? "utilidad" : "pérdida"} de ${formatCurrency(Math.abs(r))} con fecha 1-ene-${data.ejercicioDestino}.`,
          error: false,
        });
      } else if (tipo === "cerrar") {
        setMsg({ texto: `Ejercicio ${year} cerrado. Sus asientos quedan protegidos.`, error: false });
      } else {
        setMsg({ texto: `Ejercicio ${year} reabierto (${data.reabiertos} periodo(s)).`, error: false });
      }
      await onReload();
    } catch (e) {
      setMsg({ texto: e instanceof Error ? e.message : "Error", error: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={`mb-4 rounded-xl border p-4 ${
      ev.yaCerrado
        ? "border-[oklch(0.66_0.12_168_/_0.35)] bg-cos-jade-tint"
        : "border-cos-line bg-cos-card"
    }`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-semibold text-cos-ink">
            {ev.yaCerrado ? <ShieldCheck className="h-4 w-4 text-cos-jade-ink" /> : <Calendar className="h-4 w-4 text-cos-ink-soft" />}
            Ejercicio {year}
            {ev.yaCerrado && (
              <span className="rounded bg-cos-jade-tint px-2 py-0.5 text-xs font-medium text-cos-jade-ink">Cerrado</span>
            )}
          </p>
          <p className="mt-1 max-w-[68ch] text-xs text-cos-ink-soft">
            {ev.yaCerrado
              ? "Ningún proceso puede modificar los asientos de este año: ni el re-posteo automático, ni la conciliación, ni las pólizas manuales. Reábrelo si necesitas corregir algo."
              : ev.motivo ?? "El ejercicio está listo para cerrarse. Traspasa el resultado a acumulados y ciérralo para proteger sus asientos."}
          </p>
        </div>
        <div className="flex flex-none flex-wrap gap-2">
          {!ev.yaCerrado && (
            <button
              onClick={() => accion("traspaso")}
              disabled={busy !== null || !puedeTraspasar}
              title={puedeTraspasar
                ? `Traspasa el resultado de ${year} de «Utilidad del ejercicio» (305.01) a «Utilidad de ejercicios anteriores» (304.01), con fecha 1-ene-${year + 1}`
                : `Genera primero el asiento de cierre de ${year} (botón «Cierre ${year}» arriba)`}
              className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-sm font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
            >
              {busy === "traspaso" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Traspasando…</> : "Traspasar resultado"}
            </button>
          )}
          {ev.yaCerrado ? (
            <button
              onClick={() => accion("reabrir")}
              disabled={busy !== null}
              className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-sm font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
            >
              {busy === "reabrir" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Reabriendo…</> : <><RotateCcw className="h-3.5 w-3.5" /> Reabrir ejercicio</>}
            </button>
          ) : (
            <button
              onClick={() => accion("cerrar")}
              disabled={busy !== null || !ev.puedeCerrar}
              title={ev.puedeCerrar ? `Cierra definitivamente el ejercicio ${year}` : ev.motivo ?? ""}
              className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3 py-1.5 text-sm font-medium text-white hover:bg-cos-brand-deep disabled:opacity-50"
            >
              {busy === "cerrar" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Cerrando…</> : <><ShieldCheck className="h-3.5 w-3.5" /> Cerrar ejercicio</>}
            </button>
          )}
        </div>
      </div>
      {msg && (
        <p className={`mt-2.5 text-xs ${msg.error ? "text-cos-red-ink" : "text-cos-jade-ink"}`}>
          {msg.error ? "" : "✓ "}{msg.texto}
        </p>
      )}
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
        className="text-sm border border-cos-line rounded-md px-2 py-1.5 bg-cos-card"
      >
        {MESES.map((m, i) => (
          <option key={i} value={i + 1}>{m}</option>
        ))}
      </select>
      <input
        type="number"
        value={year}
        onChange={(e) => onChange(parseInt(e.target.value), month)}
        className="w-24 text-sm border border-cos-line rounded-md px-2 py-1.5 bg-cos-card"
      />
    </div>
  );
}

// ── Contabilidad Electrónica ───────────────────────────────────────────────────
// Consolida los entregables que el SAT pide cada mes (Anexo 24), generados
// AUTOMÁTICAMENTE desde la contabilidad viva de la empresa: catálogo de cuentas,
// balanza de comprobación y pólizas. No hay ensamblado manual ni carga de XML:
// el contador abre el periodo y los XML están listos para descargar.
function ContabilidadElectronicaPanel({
  companyId, periods, year, month, onChangePeriod,
}: {
  companyId: string;
  periods: Period[];
  year: number;
  month: number;
  onChangePeriod: (y: number, m: number) => void;
}) {
  const qs = `companyId=${companyId}&year=${year}&month=${month}`;

  // Readiness: ¿es confiable la CE de este periodo y qué falta si no?
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setReadinessLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/contabilidad/ce-readiness?${qs}`);
        const data = await res.json();
        if (!cancelled && res.ok) setReadiness(data as ReadinessResult);
        else if (!cancelled) setReadiness(null);
      } catch {
        if (!cancelled) setReadiness(null);
      } finally {
        if (!cancelled) setReadinessLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [qs]);

  const entregables: {
    key: string;
    label: string;
    desc: string;
    Icon: typeof BookOpen;
    href?: string;
    note?: string;
  }[] = [
    {
      key: "catalogo",
      label: "Catálogo de cuentas",
      desc: "Estructura de cuentas con su código agrupador del SAT. Se genera desde tu catálogo.",
      Icon: BookOpen,
      href: `/api/contabilidad/coe/catalogo?${qs}`,
    },
    {
      key: "balanza",
      label: "Balanza de comprobación",
      desc: "Saldos y movimientos del mes. Se genera desde tu balanza mensual (normal o complementaria automática).",
      Icon: FileCheck2,
      href: `/api/contabilidad/coe/balanza?${qs}`,
    },
    {
      key: "polizas",
      label: "Pólizas del periodo",
      desc: "Pólizas con sus auxiliares. El SAT las solicita en auditoría, devolución o compensación; requiere el folio del requerimiento.",
      Icon: FileText,
      href: `/contabilidad/polizas`,
      note: "requiere folio",
    },
  ];

  return (
    <div>
      <PeriodPicker year={year} month={month} onChange={onChangePeriod} />

      {/* ¿Lista tu Contabilidad Electrónica? — readiness del periodo */}
      <ReadinessCard
        loading={readinessLoading}
        readiness={readiness}
        mesLabel={`${MESES[month - 1]} ${year}`}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {entregables.map(({ key, label, desc, Icon, href, note }) => (
          <div key={key} className="flex flex-col rounded-card border border-cos-line bg-cos-card p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-control bg-cos-slate-tint text-cos-ink-soft">
                <Icon className="h-4 w-4" />
              </span>
              <p className="text-sm font-semibold text-cos-ink">{label}</p>
            </div>
            <p className="mb-4 flex-1 text-[13px] leading-snug text-cos-ink-soft">{desc}</p>
            {key === "polizas" ? (
              <a
                href={href}
                className="inline-flex items-center justify-center gap-1.5 rounded-control border border-cos-line bg-cos-paper px-3 py-2 text-[13px] font-medium text-cos-ink hover:bg-cos-slate-tint"
              >
                Abrir pólizas y auxiliares <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : (
              <a
                href={href}
                className="inline-flex items-center justify-center gap-1.5 rounded-control bg-cos-brand px-3 py-2 text-[13px] font-medium text-white hover:bg-cos-brand-deep"
              >
                <Download className="h-3.5 w-3.5" /> Descargar XML
              </a>
            )}
            {note && <p className="mt-2 text-[11px] text-cos-ink-faint">{note}</p>}
          </div>
        ))}
      </div>

      {/* Seguimiento: envío automático con e.firma (pendiente) */}
      <div className="mt-4 flex items-start gap-2 rounded-card border border-dashed border-cos-line px-4 py-3 text-[13px] text-cos-ink-soft">
        <Landmark className="h-4 w-4 shrink-0 mt-0.5 text-cos-ink-faint" />
        <span>
          El envío automático al SAT con tu e.firma está en camino. Por ahora descarga los XML y
          cárgalos en el portal del SAT; pronto lo haremos por ti.
        </span>
      </div>
    </div>
  );
}

// ── Tarjeta de readiness CE ─────────────────────────────────────────────────────
// Resumen claro de si la CE del periodo es confiable y, si no, qué falta. Verde
// = lista; ámbar = con huecos; rojo = incompleta. Lista los checks con su CTA.
function ReadinessCard({
  loading, readiness, mesLabel,
}: { loading: boolean; readiness: ReadinessResult | null; mesLabel: string }) {
  if (loading) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-card border border-cos-line bg-cos-card px-4 py-3 text-sm text-cos-ink-soft">
        <Loader2 className="h-4 w-4 animate-spin" /> Revisando si tu Contabilidad Electrónica está lista…
      </div>
    );
  }
  if (!readiness) {
    return (
      <div className="mb-4 flex items-start gap-2 rounded-card border border-cos-line bg-cos-slate-tint px-4 py-3 text-sm text-cos-ink">
        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-cos-ink-soft" />
        <span>No se pudo evaluar el estado de preparación de la CE de {mesLabel}.</span>
      </div>
    );
  }

  const { status, resumen, checks } = readiness;

  // Tema por estado global (sólo tokens cos-*).
  const tema = {
    lista: {
      wrap: "border-[oklch(0.66_0.12_168_/_0.28)] bg-cos-jade-tint",
      head: "text-cos-jade-ink",
      Icon: ShieldCheck,
      titulo: "Lista para el SAT",
    },
    con_huecos: {
      wrap: "border-cos-amber bg-cos-amber-tint",
      head: "text-cos-amber-ink",
      Icon: AlertCircle,
      titulo: "Casi lista",
    },
    incompleta: {
      wrap: "border-[oklch(0.6_0.2_25_/_0.22)] bg-cos-red-tint",
      head: "text-cos-red-ink",
      Icon: AlertCircle,
      titulo: "Incompleta",
    },
  }[status];

  const iconoCheck: Record<ReadinessCheckEstado, React.ReactNode> = {
    ok: <CheckCircle2 className="h-4 w-4 shrink-0 text-cos-jade-ink" />,
    warn: <Clock className="h-4 w-4 shrink-0 text-cos-amber-ink" />,
    error: <AlertCircle className="h-4 w-4 shrink-0 text-cos-red-ink" />,
  };

  return (
    <div className={`mb-5 rounded-card border ${tema.wrap}`}>
      <div className="flex items-start gap-2.5 px-4 py-3">
        <tema.Icon className={`h-5 w-5 shrink-0 mt-0.5 ${tema.head}`} />
        <div className="min-w-0">
          <p className={`text-[15px] font-semibold ${tema.head}`}>{tema.titulo} — {mesLabel}</p>
          <p className="mt-0.5 text-[13px] text-cos-ink-soft">{resumen}</p>
        </div>
      </div>

      <div className="border-t border-cos-line-soft bg-cos-card/60 px-4 py-3">
        <ul className="flex flex-col gap-2.5">
          {checks.map((c) => (
            <li key={c.clave} className="flex items-start gap-2.5">
              {iconoCheck[c.estado]}
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-cos-ink">{c.titulo}</p>
                <p className="text-[12.5px] leading-snug text-cos-ink-soft">{c.detalle}</p>
              </div>
              {c.cta && (
                <a
                  href={c.cta.href}
                  className="inline-flex flex-none items-center gap-1 rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[12px] font-semibold text-cos-brand-ink hover:bg-cos-paper"
                >
                  {c.cta.label} <ArrowRight className="h-3 w-3" />
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function BalanzaPanel({
  companyId, year, month, onChangePeriod,
}: { companyId: string; year: number; month: number; onChangePeriod: (y: number, m: number) => void }) {
  const [rows, setRows] = useState<BalanzaRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [preliminar, setPreliminar] = useState(false);
  // Drill-down: clic en una cuenta → auxiliar con saldo corrido.
  const [auxCuenta, setAuxCuenta] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(
        `/api/contabilidad/balanza?companyId=${companyId}&year=${year}&month=${month}`
      );
      const data = await res.json();
      setRows(data.rows ?? []);
      setPreliminar(Boolean(data.preliminar));
      setLoading(false);
    })();
  }, [companyId, year, month]);

  const nonZero = rows.filter(r => Math.abs(r.cargos) > 0.01 || Math.abs(r.abonos) > 0.01);

  return (
    <div>
      <PeriodPicker year={year} month={month} onChange={onChangePeriod} />

      <div className="mb-3 flex justify-end">
        <BotonExcel
          href={`/api/contabilidad/balanza?companyId=${companyId}&year=${year}&month=${month}&format=xlsx`}
          label="Balanza en Excel"
        />
      </div>

      {!loading && preliminar && nonZero.length > 0 && <PreliminarBanner />}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-cos-ink-soft py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : nonZero.length === 0 ? (
        <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-12 text-center">
          <BookOpen className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
          <p className="text-sm text-cos-ink-soft">Sin movimientos para este periodo.</p>
          <p className="text-xs text-cos-ink-soft mt-1">Cierra el mes desde la pestaña &ldquo;Cierres mensuales&rdquo;.</p>
        </div>
      ) : (
        <div className="bg-cos-card border border-cos-line rounded-xl overflow-hidden">
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
                <tr
                  key={`${r.cuentaSAT}-${r.subcuenta}-${i}`}
                  onClick={() => setAuxCuenta(r.subcuenta ?? r.cuentaSAT)}
                  title="Ver auxiliar de la cuenta"
                  className="border-b border-cos-line last:border-0 hover:bg-cos-paper/50 cursor-pointer"
                >
                  <td className="px-4 py-2 text-xs font-mono">{r.subcuenta ?? r.cuentaSAT}</td>
                  <td className="px-4 py-2">{r.nombre}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{r.cargos > 0 ? formatCurrency(r.cargos) : "—"}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{r.abonos > 0 ? formatCurrency(r.abonos) : "—"}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs font-semibold"><Money value={r.saldo} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {auxCuenta && (
        <AuxiliarCuentaModal
          companyId={companyId}
          year={year}
          month={month}
          cuenta={auxCuenta}
          onClose={() => setAuxCuenta(null)}
        />
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

      <div className="mb-3 flex justify-end">
        <BotonExcel
          href={`/api/contabilidad/estado-resultados?companyId=${companyId}&year=${year}&month=${month}&format=xlsx`}
          label="Estado de resultados en Excel"
        />
      </div>

      {!loading && data?.preliminar && (data.ingresos.length > 0 || data.gastos.length > 0 || data.costos.length > 0) && <PreliminarBanner />}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-cos-ink-soft py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : !data || (data.ingresos.length === 0 && data.gastos.length === 0 && data.costos.length === 0) ? (
        <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-12 text-center">
          <FileText className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
          <p className="text-sm text-cos-ink-soft">Sin movimientos para este periodo.</p>
        </div>
      ) : (
        <div className="bg-cos-card border border-cos-line rounded-xl p-6 space-y-5 text-sm">
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
                  <Money value={data.utilidadBruta} />
                </span>
              </div>
            )}
            <div className="flex items-center justify-between text-base font-bold">
              <span>Utilidad antes de impuestos</span>
              <span className={data.utilidadAntesImpuestos >= 0 ? "text-cos-jade-ink" : "text-cos-red-ink"}>
                <Money value={data.utilidadAntesImpuestos} />
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
            <span className="font-mono"><Money value={r.monto} /></span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-cos-line mt-2 pt-2 font-medium">
        <span>Total {label.toLowerCase()}</span>
        <span className={`font-mono ${positive ? "text-cos-jade-ink" : "text-cos-red-ink"}`}>
          <Money value={total} />
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
        <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-12 text-center">
          <ArrowLeftRight className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
          <p className="text-sm text-cos-ink-soft">Sin préstamos interempresa registrados.</p>
          <p className="text-xs text-cos-ink-soft mt-1">
            Los préstamos aparecen cuando clasificas transacciones bancarias como
            &ldquo;Préstamo otorgado&rdquo; o &ldquo;Préstamo recibido&rdquo; y cierras el mes.
          </p>
        </div>
      ) : (
        <div className="bg-cos-card border border-cos-line rounded-xl overflow-hidden">
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
                <td className="px-4 py-2.5 text-right font-mono text-xs"><Money value={totalOtorgados} /></td>
                <td className="px-4 py-2.5 text-right font-mono text-xs"><Money value={totalPorPagar} /></td>
                <td className="px-4 py-2.5 text-right font-mono text-xs font-bold">
                  <Money value={totalOtorgados - totalPorPagar} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
