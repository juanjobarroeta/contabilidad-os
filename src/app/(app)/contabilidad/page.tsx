"use client";

import { useCallback, useEffect, useState } from "react";
import { Money } from "@/components/ui";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency } from "@/lib/utils";
import {
  Calendar, CheckCircle2, AlertCircle, Loader2, X,
  RotateCcw, FileText, BookOpen, Download, ArrowLeftRight, Boxes,
  Landmark, FileCheck2, ShieldCheck,
  ScrollText, Scale,
} from "lucide-react";
import { ActivoFijoView } from "@/components/contabilidad/ActivoFijoView";
import { LibroDiarioPanel, BalanceGeneralPanel } from "@/components/contabilidad/LibroPanels";
import { ConciliacionBancariaPanel } from "@/components/contabilidad/ConciliacionBancariaPanel";
import { CePresentadoPanel } from "@/components/contabilidad/CePresentadoPanel";
import { evaluarCierreEjercicio } from "@/lib/contabilidad/ejercicio";
import { PeriodPicker } from "@/components/contabilidad/PeriodPicker";
import { BalanzaPanel } from "@/components/contabilidad/BalanzaPanel";
import { EstadoResultadosPanel } from "@/components/contabilidad/EstadoResultadosPanel";
import { SaldosInterempresaPanel } from "@/components/contabilidad/SaldosInterempresaPanel";
import { ContabilidadElectronicaPanel, type Period } from "@/components/contabilidad/ContabilidadElectronicaPanel";

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

type TabId = "periods" | "coe" | "ce-presentado" | "libro" | "balanza" | "conciliacion" | "estado" | "balance" | "saldos" | "activo-fijo";

const TAB_IDS: readonly TabId[] = ["periods", "coe", "ce-presentado", "libro", "balanza", "conciliacion", "estado", "balance", "saldos", "activo-fijo"];

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
            ["ce-presentado", "Presentado (CE)", FileCheck2],
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

      {tab === "ce-presentado" && (
        <CePresentadoPanel companyId={activeCompany.id} />
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
