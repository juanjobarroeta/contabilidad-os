"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  ChevronLeft, ChevronRight, Calculator, Save, CheckCircle2,
  AlertCircle, Loader2, FileText, TrendingUp, TrendingDown,
  Info, RefreshCw, ArrowUpRight, ArrowDownLeft, Sparkles, Pencil, X,
  Receipt, CreditCard, Calendar, ExternalLink,
} from "lucide-react";

const MONTHS = [
  "Enero","Febrero","Marzo","Abril","Mayo","Junio",
  "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre",
];

// ── Types ─────────────────────────────────────────────────────────────────────
interface IvaApiData {
  trasladado: number;
  retenidoPorClientes: number;
  /** Acreditable procedente — ya aplicada la proporción Art. 5-V. */
  acreditable: number;
  acreditableBruto: number;
  proporcionAcreditamiento: number;
  actosGravados: number;
  actosExentos: number;
  saldoFavorAnterior: number;
  saldoFavorAnteriorPeriodo: string | null;
}
type IsrMetodo = "PM_ART14" | "PF_ACT_EMPRESARIAL" | "RESICO_PF" | "PF_ARRENDAMIENTO" | "PF_PLATAFORMAS";
interface IsrApiData {
  metodo: IsrMetodo;
  ingresosDelMes: number;
  gastosDelMes: number;
  ingresosAcumulados: number;
  isrPagadoAnterior: number;
  coeficiente: number | null;
  coeficienteFuente: "manual" | "declaracion_anual" | "provisional_previo" | "calculado" | "ninguno";
  /** Mejor coeficiente AUTO-detectado (anual → provisionales → CFDIs), aunque haya override manual. */
  coeficienteSugerido?: number | null;
  coeficienteSugeridoFuente?: "declaracion_anual" | "provisional_previo" | "calculado" | "ninguno" | null;
  coeficienteBase: {
    year: number;
    ingresos: number;
    utilidad: number;
    invoiceCount: number;
  } | null;
  /** Server-computed figures (régimen-aware). For PF/RESICO these are authoritative. */
  baseGravable: number | null;
  tasa: number | null;
  utilidadFiscal: number | null;
  isrDelEjercicio: number | null;
  isrPagar: number | null;
  /** ISR retenido acreditado contra el provisional/definitivo (10% PM Art. 106 PF; 1.25% Art. 113-J RESICO). */
  retencionesAcreditadas: number;
  /** Saldo a favor ISR arrastrado del periodo anterior (RESICO). 0 si no aplica. */
  saldoFavorAnterior: number;
  /** Saldo a favor ISR generado este periodo — se arrastra al guardar (RESICO). 0 si no aplica. */
  saldoAFavor: number;
  tarifaVerificada: boolean;
  plataformaActividad?: { kind: string; label: string; asumida: boolean } | null;
}

const ISR_METODO_LABEL: Record<IsrMetodo, string> = {
  PM_ART14: "Art. 14 LISR (coeficiente)",
  PF_ACT_EMPRESARIAL: "Art. 106 LISR (act. empresarial)",
  RESICO_PF: "Art. 113-E LISR (RESICO)",
  PF_ARRENDAMIENTO: "Arts. 114-116 LISR (arrendamiento)",
  PF_PLATAFORMAS: "Art. 113-A LISR (plataformas)",
};
interface FacturaRow {
  id: string;
  uuid: string | null;
  tipo: "INGRESO" | "EGRESO" | "NOMINA";
  fecha: string;
  contraparte: string;
  rfc: string;
  subtotal: number;
  iva: number;
  total: number;
}
interface ApiResult {
  periodo: string;
  month: number;
  year: number;
  cutoffDate: string | null;
  isPreliminar: boolean;
  iva: IvaApiData;
  isr: IsrApiData;
  asimilados: {
    recibos: { id: string; uuid: string | null; fecha: string; emisor: string; rfc: string; regimenLabel: string | null; ingreso: number; isrRetenido: number; esDelMes: boolean }[];
    mes: { ingreso: number; isrRetenido: number };
    anual: { ingreso: number; isrRetenido: number };
  } | null;
  facturas: FacturaRow[];
  declaracionGuardada: {
    id: string;
    status: string;
    isHistorical?: boolean;
    saldoFavorAnteriorOverride: number | null;
    coeficienteOverride: number | null;
    acuseUrl: string | null;
    lineaCaptura: string | null;
    fechaPresentacion: string | null;
    fechaLimitePago: string | null;
  } | null;
}

// ── SAT request types ─────────────────────────────────────────────────────────
interface SatRequestRow {
  id: string;
  tipo: "EMITIDOS" | "RECIBIDOS";
  year: number;
  month: number;
  requestId: string;
  status: "PENDING" | "ACCEPTED" | "IN_PROGRESS" | "FINISHED" | "FAILED" | "EXPIRED";
  cfdisFound: number;
  imported: number;
  lastVerifiedAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

const SAT_STATUS_LABELS: Record<string, string> = {
  PENDING:     "Pendiente",
  ACCEPTED:    "Aceptada por SAT",
  IN_PROGRESS: "Procesando en SAT",
  FINISHED:    "Lista",
  FAILED:      "Falló",
  EXPIRED:     "Expiró",
};

const SAT_STATUS_COLORS: Record<string, string> = {
  PENDING:     "bg-gray-100 text-gray-700",
  ACCEPTED:    "bg-blue-50 text-blue-700",
  IN_PROGRESS: "bg-amber-50 text-amber-700",
  FINISHED:    "bg-green-50 text-green-700",
  FAILED:      "bg-red-50 text-red-700",
  EXPIRED:     "bg-gray-100 text-gray-500",
};

// ── Status helpers ─────────────────────────────────────────────────────────────
const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Borrador", CALCULATED: "Calculada", FILED: "Presentada", PAID: "Pagada",
};
const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  CALCULATED: "bg-blue-100 text-blue-700",
  FILED: "bg-yellow-100 text-yellow-700",
  PAID: "bg-green-100 text-green-700",
};

// ── Helpers ────────────────────────────────────────────────────────────────────
function periodLabel(periodo: string) {
  const [y, m] = periodo.split("-");
  return `${MONTHS[parseInt(m) - 1]} ${y}`;
}

function Row({
  label, value, bold, accent, indent, children,
}: {
  label: string; value?: string; bold?: boolean;
  accent?: "green" | "red" | "blue" | "purple";
  indent?: boolean;
  children?: React.ReactNode;
}) {
  const valueClass =
    accent === "green"  ? "text-green-700 font-semibold" :
    accent === "red"    ? "text-red-700 font-semibold" :
    accent === "blue"   ? "text-blue-700 font-semibold" :
    accent === "purple" ? "text-purple-700 font-semibold" :
    bold                ? "font-semibold" :
                          "text-muted-foreground";

  return (
    <div className={`flex justify-between items-center py-1.5 ${bold ? "border-t border-border mt-1 pt-2.5" : ""} ${indent ? "pl-3" : ""}`}>
      <span className={`text-sm ${bold ? "font-medium" : "text-muted-foreground"}`}>{label}</span>
      {children ?? <span className={`text-sm ${valueClass}`}>{value}</span>}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function ImpuestosPage() {
  const { activeCompany } = useCompany();
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear]   = useState(now.getFullYear());
  // cutoffDate: optional mid-month cutoff for "precierre" mode. If null the
  // full calendar month is used. Stored as "YYYY-MM-DD" string.
  const [cutoffDate, setCutoffDate] = useState<string | null>(null);
  // Fiscal projection inputs — hypothetical additional amounts
  const [projIngresoAdicional, setProjIngresoAdicional] = useState("");
  const [projGastoAdicional, setProjGastoAdicional] = useState("");

  // Honor the period from the Declaración Workspace deep-link (?month=&year=).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const m = parseInt(sp.get("month") ?? ""); if (m >= 1 && m <= 12) setMonth(m);
    const y = parseInt(sp.get("year") ?? ""); if (y >= 2000 && y <= 2100) setYear(y);
  }, []);

  const [loading, setLoading]   = useState(false);
  const [saving, setSaving]     = useState(false);
  const [result, setResult]     = useState<ApiResult | null>(null);
  const [error, setError]       = useState("");
  const [savedStatus, setSavedStatus] = useState<string | null>(null);
  const [isHistorical, setIsHistorical] = useState(false);

  // Complemento de pagos (REP) check — PPDs with bank match but missing REP
  const [repPending, setRepPending] = useState<{ count: number; monto: number; invoices: { id: string; folio: string | null; serie: string | null; customer: string; pendingAmount: number; uuid: string | null }[] }>({ count: 0, monto: 0, invoices: [] });
  const [repEmitting, setRepEmitting] = useState(false);

  // User-adjustable overrides (initialized from API / saved declaration)
  const [saldoFavorAnterior, setSaldoFavorAnterior] = useState(0);
  const [saldoFavorEdited, setSaldoFavorEdited]     = useState(false);
  const [coeficiente, setCoeficiente]               = useState<number | null>(null);
  const [coeficienteEdited, setCoeficienteEdited]   = useState(false);

  // Invoice filter
  const [facturaFilter, setFacturaFilter] = useState<"all" | "INGRESO" | "EGRESO" | "NOMINA">("all");

  // Acuse de recibo
  const [acuseUrl, setAcuseUrl]                     = useState("");
  const [lineaCaptura, setLineaCaptura]             = useState("");
  const [fechaPresentacion, setFechaPresentacion]   = useState("");
  const [fechaLimitePago, setFechaLimitePago]       = useState("");
  const [savingAcuse, setSavingAcuse]               = useState(false);
  const [acuseEditMode, setAcuseEditMode]           = useState(false);

  // SAT sync
  const [syncing, setSyncing]     = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  const [syncDone, setSyncDone]   = useState(false);
  const [satRequests, setSatRequests] = useState<SatRequestRow[]>([]);

  // ── Derived IVA ──────────────────────────────────────────────────────────────
  const ivaComputed = useMemo(() => {
    if (!result) return null;
    const { trasladado, retenidoPorClientes, acreditable } = result.iva;
    const cargo = trasladado - retenidoPorClientes - acreditable - saldoFavorAnterior;
    return {
      trasladado, retenidoPorClientes, acreditable, saldoFavorAnterior,
      pagar: cargo > 0 ? cargo : 0,
      saldoFavor: cargo < 0 ? Math.abs(cargo) : 0,
    };
  }, [result, saldoFavorAnterior]);

  // ── Derived ISR (régimen-aware) ──────────────────────────────────────────────
  // PM (Art. 14): live recompute from the user-editable coeficiente.
  // PF act. empresarial / RESICO: the server (computeTaxPosition) is authoritative
  // — there is no coeficiente to edit, so we display its figures directly.
  const isrComputed = useMemo(() => {
    if (!result) return null;
    const isr = result.isr;
    if (isr.metodo === "PM_ART14") {
      if (coeficiente === null || coeficiente === 0) return null;
      const utilidadFiscal   = isr.ingresosAcumulados * coeficiente;
      const isrDelEjercicio  = utilidadFiscal * 0.30;
      const esteMes          = Math.max(0, isrDelEjercicio - isr.isrPagadoAnterior);
      return { utilidadFiscal, isrDelEjercicio, esteMes, baseGravable: utilidadFiscal, tasa: 0.30 };
    }
    if (isr.isrPagar === null) return null;
    return {
      utilidadFiscal: isr.baseGravable ?? 0,
      isrDelEjercicio: isr.isrDelEjercicio ?? isr.isrPagar,
      esteMes: isr.isrPagar,
      baseGravable: isr.baseGravable ?? 0,
      tasa: isr.tasa,
    };
  }, [result, coeficiente]);

  // ── Fetch ────────────────────────────────────────────────────────────────────
  const calcular = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ companyId: activeCompany.id, month: String(month), year: String(year) });
      if (cutoffDate) params.set("cutoffDate", cutoffDate);
      const res = await fetch(`/api/impuestos?${params}`);
      if (!res.ok) throw new Error("Error al calcular");
      const data: ApiResult = await res.json();
      setResult(data);
      setSavedStatus(data.declaracionGuardada?.status ?? null);
      setIsHistorical(data.declaracionGuardada?.isHistorical ?? false);

      // Fire-and-forget check for missing complementos de pago
      fetch(`/api/facturas/complemento-pagos?companyId=${activeCompany.id}`)
        .then(r => r.ok ? r.json() : null)
        .then((repData) => {
          if (!repData) return;
          const needing = (repData.pendientes ?? []).filter((p: { needsRep: boolean }) => p.needsRep);
          setRepPending({
            count: needing.length,
            monto: needing.reduce((s: number, p: { pendingAmount: number }) => s + p.pendingAmount, 0),
            invoices: needing.map((p: { invoice: { id: string; folio: string | null; serie: string | null; uuid: string | null; customer: { razonSocial: string } | null }; pendingAmount: number }) => ({
              id: p.invoice.id,
              folio: p.invoice.folio,
              serie: p.invoice.serie,
              uuid: p.invoice.uuid,
              customer: p.invoice.customer?.razonSocial ?? "—",
              pendingAmount: p.pendingAmount,
            })),
          });
        })
        .catch(() => { /* silent */ });

      // Restore saved overrides, otherwise use auto values
      const savedSaldo = data.declaracionGuardada?.saldoFavorAnteriorOverride;
      const savedCoef  = data.declaracionGuardada?.coeficienteOverride;

      setSaldoFavorAnterior(savedSaldo != null ? savedSaldo : data.iva.saldoFavorAnterior);
      setSaldoFavorEdited(savedSaldo != null && savedSaldo !== data.iva.saldoFavorAnterior);
      setCoeficiente(savedCoef != null ? savedCoef : data.isr.coeficiente);
      setCoeficienteEdited(savedCoef != null && savedCoef !== data.isr.coeficiente);

      // Restore acuse fields
      const saved = data.declaracionGuardada;
      setAcuseUrl(saved?.acuseUrl ?? "");
      setLineaCaptura(saved?.lineaCaptura ?? "");
      setFechaPresentacion(saved?.fechaPresentacion ? saved.fechaPresentacion.substring(0,10) : "");
      setFechaLimitePago(saved?.fechaLimitePago ? saved.fechaLimitePago.substring(0,10) : "");
      setAcuseEditMode(!saved?.acuseUrl && !saved?.lineaCaptura);
    } catch {
      setError("No se pudo calcular la declaración");
    } finally {
      setLoading(false);
    }
  }, [activeCompany, month, year, cutoffDate]);

  useEffect(() => { calcular(); }, [calcular]);

  // ── Fetch SAT requests for the period ──────────────────────────────────────
  const loadSatRequests = useCallback(async () => {
    if (!activeCompany) return;
    try {
      const res = await fetch(
        `/api/sat/sync/requests?companyId=${activeCompany.id}&year=${year}&month=${month}`
      );
      if (!res.ok) return;
      const data = await res.json();
      setSatRequests(data.requests ?? []);
    } catch { /* ignore */ }
  }, [activeCompany, year, month]);

  useEffect(() => { loadSatRequests(); }, [loadSatRequests]);

  function prevMonth() {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }

  // ── Save ─────────────────────────────────────────────────────────────────────
  async function handleGuardar(status: "CALCULATED" | "FILED") {
    if (!activeCompany || !result || !ivaComputed) return;
    setSaving(true);
    try {
      const res = await fetch("/api/impuestos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: activeCompany.id,
          periodo: result.periodo,
          tipo: "IVA_MENSUAL",
          year: result.year,
          ivaData: {
            trasladado:  ivaComputed.trasladado,
            acreditable: ivaComputed.acreditable,
            saldoFavor:  ivaComputed.saldoFavor,
            pagar:       ivaComputed.pagar,
          },
          isrData: isrComputed ? {
            ingresosAcumulados: result.isr.ingresosAcumulados,
            gastosDelMes:       result.isr.gastosDelMes,
            baseGravable:       isrComputed.baseGravable,
            isrPagar:           isrComputed.esteMes,
            tasa:               isrComputed.tasa,
            // Saldo a favor RESICO generado (retención 1.25% > causado) — la fila
            // guardada es el eslabón del arrastre que el motor lee el mes siguiente.
            saldoAFavor:        result.isr.saldoAFavor,
          } : null,
          saldoFavorAnterior,
          // Coeficiente sólo aplica a PM (Art. 14); para PF/RESICO va null.
          coeficienteUtilidad: result.isr.metodo === "PM_ART14" ? coeficiente : null,
          status,
        }),
      });
      if (!res.ok) throw new Error("Error al guardar");
      const saved = await res.json();
      setSavedStatus(saved.status);
    } catch {
      setError("No se pudo guardar la declaración");
    } finally {
      setSaving(false);
    }
  }

  // ── Save acuse ────────────────────────────────────────────────────────────────
  async function handleGuardarAcuse() {
    if (!activeCompany || !result) return;
    setSavingAcuse(true);
    try {
      const res = await fetch("/api/impuestos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: activeCompany.id,
          periodo: result.periodo,
          tipo: "IVA_MENSUAL",
          year: result.year,
          status: savedStatus ?? "FILED",
          acuseUrl:          acuseUrl     || null,
          lineaCaptura:      lineaCaptura || null,
          fechaPresentacion: fechaPresentacion || null,
          fechaLimitePago:   fechaLimitePago   || null,
        }),
      });
      if (!res.ok) throw new Error("Error al guardar acuse");
      const saved = await res.json();
      setSavedStatus(saved.status);
      setAcuseEditMode(false);
    } catch {
      setError("No se pudo guardar el acuse");
    } finally {
      setSavingAcuse(false);
    }
  }

  // ── SAT sync ─────────────────────────────────────────────────────────────────
  async function handleSatSync(force = false) {
    if (!activeCompany) return;
    setSyncing(true); setSyncDone(false); setSyncStatus(force ? "Forzando nueva solicitud al SAT..." : "Autenticando con el SAT..."); setError("");
    try {
      const reqRes = await fetch("/api/sat/sync", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, month, year, force }),
      });
      const reqData = await reqRes.json();
      if (!reqRes.ok) throw new Error(reqData.error ?? "Error al solicitar CFDIs al SAT");

      const { emitidosRequestId, recibidosRequestId } = reqData;
      setSyncStatus("Solicitud enviada al SAT. Esperando paquetes...");

      let attempts = 0;
      const poll = async (): Promise<void> => {
        if (attempts++ >= 24) {
          setSyncStatus("El SAT tarda más de lo esperado. Intenta de nuevo en unos minutos.");
          setSyncing(false); return;
        }
        const verRes = await fetch("/api/sat/sync/verify", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ companyId: activeCompany.id, emitidosRequestId, recibidosRequestId, month, year }),
        });
        const verData = await verRes.json();
        if (verData.status === "pending") {
          setSyncStatus(verData.message ?? "Preparando paquetes...");
          await new Promise(r => setTimeout(r, 5000)); return poll();
        }
        if (verData.status === "empty") { setSyncStatus("No se encontraron CFDIs en este período."); setSyncDone(true); setSyncing(false); loadSatRequests(); return; }
        if (verData.status === "done" || verData.status === "partial") { setSyncStatus(verData.message ?? "¡Listo!"); setSyncDone(true); setSyncing(false); calcular(); loadSatRequests(); return; }
        throw new Error(verData.error ?? "Error en sincronización");
      };
      await poll();
      loadSatRequests();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al sincronizar"); setSyncing(false);
      loadSatRequests();
    }
  }

  // ── Filtered facturas ─────────────────────────────────────────────────────────
  const filteredFacturas = useMemo(() => {
    if (!result) return [];
    return facturaFilter === "all" ? result.facturas : result.facturas.filter(f => f.tipo === facturaFilter);
  }, [result, facturaFilter]);

  if (!activeCompany) return (
    <div className="p-8 text-muted-foreground text-sm">Selecciona una empresa para ver sus declaraciones.</div>
  );

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Declaraciones Fiscales</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{activeCompany.razonSocial}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <a
            href={`/api/impuestos/diot?companyId=${activeCompany.id}&month=${month}&year=${year}&format=txt`}
            className="flex items-center gap-2 border border-border px-3 py-2 rounded-md text-xs font-medium hover:bg-accent"
            title="Descargar DIOT del periodo"
          >
            <FileText className="h-3.5 w-3.5" /> DIOT
          </a>
          <a
            href="/impuestos/papeles"
            className="flex items-center gap-2 border border-border px-3 py-2 rounded-md text-xs font-medium hover:bg-accent"
          >
            <FileText className="h-3.5 w-3.5" /> Papeles
          </a>
        </div>
      </div>

      {/* Period selector */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <button onClick={() => { prevMonth(); setCutoffDate(null); }} className="p-1.5 rounded-md border border-border hover:bg-accent transition-colors">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-lg font-semibold min-w-[160px] text-center">{MONTHS[month - 1]} {year}</span>
        <button onClick={() => { nextMonth(); setCutoffDate(null); }} className="p-1.5 rounded-md border border-border hover:bg-accent transition-colors">
          <ChevronRight className="h-4 w-4" />
        </button>
        {savedStatus && (
          <span className={`ml-3 px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[savedStatus] ?? "bg-gray-100 text-gray-600"}`}>
            {STATUS_LABELS[savedStatus] ?? savedStatus}
          </span>
        )}
        {isHistorical && (
          <span className="ml-2 px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-100 text-indigo-700">
            📄 Importado del SAT
          </span>
        )}

        {/* Precierre cutoff picker */}
        <div className="ml-auto flex items-center gap-2">
          <label className="text-xs text-muted-foreground">Precierre hasta:</label>
          <input
            type="date"
            value={cutoffDate ?? ""}
            min={`${year}-${String(month).padStart(2, "0")}-01`}
            max={`${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`}
            onChange={(e) => setCutoffDate(e.target.value || null)}
            className="text-xs border border-border rounded-md px-2 py-1.5 bg-white"
          />
          {cutoffDate && (
            <button
              onClick={() => setCutoffDate(null)}
              className="text-xs text-muted-foreground hover:text-foreground"
              title="Limpiar cutoff (usar mes completo)"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Preliminar banner */}
      {result?.isPreliminar && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-900 mb-4">
          <Info className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            <strong>Cálculo preliminar</strong> — valores estimados con datos hasta el <strong>{cutoffDate}</strong>.
            No incluye CFDIs ni movimientos bancarios posteriores a esa fecha.
          </span>
        </div>
      )}

      {/* Precierre — Complementos de Pago pendientes */}
      {repPending.count > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 mb-4">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-red-900">
                Precierre: {repPending.count} complemento{repPending.count !== 1 ? "s" : ""} de pago pendiente{repPending.count !== 1 ? "s" : ""}
              </p>
              <p className="text-xs text-red-700 mt-0.5">
                {repPending.count} factura{repPending.count !== 1 ? "s" : ""} PPD con pago recibido en banco pero sin REP emitido.
                Monto pendiente: <strong>{formatCurrency(repPending.monto)}</strong>.
                SAT requiere el complemento para documentar la cobranza.
              </p>
              <details className="mt-2">
                <summary className="text-xs font-medium text-red-800 cursor-pointer hover:underline">Ver facturas</summary>
                <div className="mt-2 space-y-1">
                  {repPending.invoices.map(inv => (
                    <div key={inv.id} className="flex items-center justify-between bg-white border border-red-200 rounded px-2.5 py-1.5 text-xs">
                      <span className="font-mono text-muted-foreground">{inv.serie ?? ""}{inv.folio ?? inv.uuid?.slice(-8)}</span>
                      <span className="flex-1 mx-3 truncate">{inv.customer}</span>
                      <span className="font-mono">{formatCurrency(inv.pendingAmount)}</span>
                    </div>
                  ))}
                </div>
              </details>
              <div className="flex gap-2 mt-3">
                <button
                  onClick={async () => {
                    setRepEmitting(true);
                    let emitted = 0;
                    const errors: string[] = [];
                    for (const inv of repPending.invoices) {
                      try {
                        const res = await fetch("/api/facturas/complemento-pagos", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            companyId: activeCompany.id,
                            invoiceId: inv.id,
                            monto: inv.pendingAmount,
                          }),
                        });
                        if (res.ok) emitted++;
                        else errors.push(`${inv.customer}: ${(await res.json()).error ?? "Error"}`);
                      } catch { errors.push(inv.customer); }
                    }
                    setRepEmitting(false);
                    if (errors.length === 0) {
                      setError(`✓ ${emitted} complemento${emitted !== 1 ? "s" : ""} de pago emitido${emitted !== 1 ? "s" : ""}`);
                    } else {
                      setError(`Emitidos ${emitted} de ${repPending.invoices.length}. Errores: ${errors.slice(0, 3).join("; ")}`);
                    }
                    setRepPending({ count: 0, monto: 0, invoices: [] });
                    // Reload
                    calcular();
                  }}
                  disabled={repEmitting}
                  className="flex items-center gap-1.5 bg-red-600 text-white px-3 py-1.5 rounded-md text-xs font-medium hover:bg-red-700 disabled:opacity-50"
                >
                  {repEmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                  Emitir {repPending.count} complemento{repPending.count !== 1 ? "s" : ""}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-4">
          <AlertCircle className="h-4 w-4 shrink-0" />{error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-12 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" />Calculando declaración...
        </div>
      ) : result && ivaComputed ? (
        <div className="space-y-5">

          {/* ── IVA Card ── */}
          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-blue-100 flex items-center justify-center">
                  <Calculator className="h-4 w-4 text-blue-600" />
                </div>
                <div>
                  <h2 className="font-semibold text-sm">IVA Mensual</h2>
                  <p className="text-xs text-muted-foreground">Período {result.periodo}</p>
                </div>
              </div>
              {ivaComputed.pagar > 0 ? (
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">A pagar</p>
                  <p className="text-lg font-bold text-red-600">{formatCurrency(ivaComputed.pagar)}</p>
                </div>
              ) : ivaComputed.saldoFavor > 0 ? (
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Saldo a favor</p>
                  <p className="text-lg font-bold text-green-600">{formatCurrency(ivaComputed.saldoFavor)}</p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Sin movimiento</p>
              )}
            </div>
            <div className="px-5 py-4 space-y-0.5">
              <Row label="IVA trasladado cobrado a clientes" value={formatCurrency(ivaComputed.trasladado)} />
              {ivaComputed.retenidoPorClientes > 0 && (
                <Row label="IVA retenido por clientes" value={`(${formatCurrency(ivaComputed.retenidoPorClientes)})`} />
              )}
              {result.iva.proporcionAcreditamiento < 1 ? (
                <>
                  <Row label="IVA acreditable bruto (facturas de proveedores)" value={formatCurrency(result.iva.acreditableBruto)} />
                  <Row
                    label={`× Proporción de acreditamiento Art. 5-V (${(result.iva.proporcionAcreditamiento * 100).toFixed(2)}%)`}
                    value=""
                    indent
                  />
                  <Row label="= IVA acreditable procedente" value={`(${formatCurrency(ivaComputed.acreditable)})`} indent bold />
                </>
              ) : (
                <Row label="IVA acreditable (facturas de proveedores)" value={`(${formatCurrency(ivaComputed.acreditable)})`} />
              )}

              {/* Saldo a favor anterior — auto-filled, editable */}
              <Row label="Saldo a favor meses anteriores">
                <div className="flex items-center gap-2">
                  {saldoFavorEdited ? (
                    <>
                      <input
                        type="number" min="0" step="0.01"
                        value={saldoFavorAnterior || ""}
                        placeholder="0.00"
                        onChange={e => { const n = parseFloat(e.target.value); setSaldoFavorAnterior(isNaN(n) ? 0 : n); }}
                        className="w-28 text-right text-sm border border-border rounded-md px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                      <button onClick={() => { setSaldoFavorAnterior(result.iva.saldoFavorAnterior); setSaldoFavorEdited(false); }}
                        className="text-muted-foreground hover:text-foreground" title="Restablecer">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      {saldoFavorAnterior > 0 ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-green-50 text-green-700">
                          <Sparkles className="h-3 w-3" />
                          {result.iva.saldoFavorAnteriorPeriodo
                            ? `Auto de ${periodLabel(result.iva.saldoFavorAnteriorPeriodo)}`
                            : "Automático"}
                        </span>
                      ) : null}
                      <span className="text-sm text-muted-foreground">
                        {saldoFavorAnterior > 0 ? `(${formatCurrency(saldoFavorAnterior)})` : formatCurrency(0)}
                      </span>
                      <button onClick={() => setSaldoFavorEdited(true)}
                        className="text-muted-foreground hover:text-foreground ml-1" title="Ajustar">
                        <Pencil className="h-3 w-3" />
                      </button>
                    </div>
                  )}
                </div>
              </Row>

              <Row
                label={ivaComputed.pagar > 0 ? "IVA a cargo" : "Saldo a favor este mes"}
                value={formatCurrency(ivaComputed.pagar > 0 ? ivaComputed.pagar : ivaComputed.saldoFavor)}
                bold accent={ivaComputed.pagar > 0 ? "red" : "green"}
              />
            </div>
            {result.iva.proporcionAcreditamiento < 1 && (
              <div className="px-5 pb-4">
                <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700">
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  Este mes facturaste actos exentos ({formatCurrency(result.iva.actosExentos)}) además de gravados
                  ({formatCurrency(result.iva.actosGravados)}). Por Art. 5-V LIVA el IVA de los gastos sólo se acredita
                  en la proporción gravados ÷ total; el resto ({formatCurrency(result.iva.acreditableBruto - result.iva.acreditable)})
                  no es acreditable.
                </div>
              </div>
            )}
            {ivaComputed.acreditable === 0 && (
              <div className="px-5 pb-4">
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  El IVA acreditable se calculará automáticamente al importar facturas de proveedores desde el SAT.
                </div>
              </div>
            )}
          </div>

          {/* ── Fiscal projection widget ── */}
          <ProjectionCard
            companyId={activeCompany.id}
            month={month}
            year={year}
            projIngresoAdicional={projIngresoAdicional}
            projGastoAdicional={projGastoAdicional}
            onIngresoChange={setProjIngresoAdicional}
            onGastoChange={setProjGastoAdicional}
          />

          {/* ── ISR Card ── */}
          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-purple-100 flex items-center justify-center">
                  <TrendingUp className="h-4 w-4 text-purple-600" />
                </div>
                <div>
                  <h2 className="font-semibold text-sm">
                    ISR {result.isr.metodo === "RESICO_PF" || result.isr.metodo === "PF_PLATAFORMAS" ? "Mensual" : "Provisional"}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {result.isr.metodo === "RESICO_PF" || result.isr.metodo === "PF_ARRENDAMIENTO" || result.isr.metodo === "PF_PLATAFORMAS"
                      ? MONTHS[month - 1]
                      : `Acumulado ${MONTHS[0]}–${MONTHS[month - 1]}`}{" "}
                    {year} · {ISR_METODO_LABEL[result.isr.metodo]}
                  </p>
                  {!result.isr.tarifaVerificada && (
                    <p className="text-[11px] text-amber-600 flex items-center gap-1 mt-0.5">
                      <Info className="h-3 w-3" /> Tarifa sin verificar contra Anexo 8
                    </p>
                  )}
                </div>
              </div>
              {isrComputed ? (
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">A pagar este mes</p>
                  <p className="text-lg font-bold text-purple-700">{formatCurrency(isrComputed.esteMes)}</p>
                </div>
              ) : (
                <span className="text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2 py-1 rounded-md">
                  {result.isr.metodo === "PM_ART14" ? "Requiere coeficiente" : "Tarifa no disponible"}
                </span>
              )}
            </div>
            {result.isr.metodo === "PM_ART14" ? (
            <>
            <div className="px-5 py-4 space-y-0.5">
              <Row
                label={`Ingresos acumulados ${MONTHS[0]}–${MONTHS[month - 1]} (${month} mes${month > 1 ? "es" : ""})`}
                value={formatCurrency(result.isr.ingresosAcumulados)}
                accent="blue"
              />

              {/* Coeficiente row with source badge + inline edit */}
              <Row label="× Coeficiente de utilidad">
                <div className="flex items-center gap-2">
                  {/* Source badge */}
                  {!coeficienteEdited && result.isr.coeficienteFuente !== "ninguno" && (
                    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${
                      result.isr.coeficienteFuente === "calculado"
                        ? "bg-green-50 text-green-700"
                        : "bg-blue-50 text-blue-700"
                    }`}>
                      <Sparkles className="h-3 w-3" />
                      {result.isr.coeficienteFuente === "calculado"
                        ? `Calculado de ${result.isr.coeficienteBase?.year}`
                        : "Confirmado"}
                    </span>
                  )}
                  <input
                    type="number" min="0" max="1" step="0.0001"
                    value={coeficiente != null && coeficiente > 0 ? coeficiente : ""}
                    placeholder="0.0000"
                    onChange={e => {
                      const n = parseFloat(e.target.value);
                      setCoeficiente(isNaN(n) ? null : Math.min(1, Math.max(0, n)));
                      setCoeficienteEdited(true);
                    }}
                    className="w-24 text-right text-sm border border-border rounded-md px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  {coeficienteEdited && (
                    <button
                      onClick={() => { setCoeficiente(result.isr.coeficiente); setCoeficienteEdited(false); }}
                      className="text-muted-foreground hover:text-foreground" title="Restablecer calculado">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {/* Toggler: adoptar el coeficiente que el sistema detecta (anual /
                      provisionales / CFDIs) cuando difiere del que se está aplicando. */}
                  {result.isr.coeficienteSugerido != null &&
                    (coeficiente == null || Math.abs(result.isr.coeficienteSugerido - coeficiente) > 0.0005) && (
                      <button
                        onClick={() => { setCoeficiente(result.isr.coeficienteSugerido!); setCoeficienteEdited(true); }}
                        className="inline-flex items-center gap-1 rounded-md border border-primary/40 px-2 py-0.5 text-xs font-semibold text-primary hover:bg-primary/10"
                        title={`Usar el coeficiente detectado por el sistema${
                          result.isr.coeficienteSugeridoFuente === "declaracion_anual" ? ` (de tu declaración anual ${year - 1})`
                            : result.isr.coeficienteSugeridoFuente === "provisional_previo" ? " (el aplicado en tus provisionales)"
                            : result.isr.coeficienteSugeridoFuente === "calculado" ? ` (estimado de tus CFDIs ${year - 1})`
                            : ""}`}
                      >
                        <Sparkles className="h-3 w-3" /> Usar {(result.isr.coeficienteSugerido * 100).toFixed(2)}%
                      </button>
                    )}
                </div>
              </Row>

              {isrComputed ? (
                <>
                  <Row label="= Utilidad fiscal estimada" value={formatCurrency(isrComputed.utilidadFiscal)} indent />
                  <Row label="× Tasa ISR (30%)" value="" indent />
                  <Row label="= ISR del ejercicio estimado" value={formatCurrency(isrComputed.isrDelEjercicio)} indent bold />
                  {result.isr.isrPagadoAnterior > 0 && (
                    <Row
                      label={`− ISR pagado meses anteriores (${month - 1} pago${month > 2 ? "s" : ""})`}
                      value={`(${formatCurrency(result.isr.isrPagadoAnterior)})`}
                    />
                  )}
                  <Row
                    label="ISR a pagar este mes"
                    value={formatCurrency(isrComputed.esteMes)}
                    bold accent="purple"
                  />
                </>
              ) : (
                <div className="mt-2 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  {result.isr.coeficienteFuente === "ninguno"
                    ? `No hay CFDIs de ${result.isr.ingresosAcumulados === 0 ? "ningún año" : `${year - 1}`} en el sistema para calcular el coeficiente automáticamente. Ingresa tu coeficiente arriba.`
                    : "Ingresa el coeficiente para calcular el ISR provisional."}
                </div>
              )}
            </div>

            {/* Coeficiente explanation */}
            {result.isr.coeficienteFuente === "calculado" && result.isr.coeficienteBase && (
              <div className="px-5 pb-4">
                <div className="flex items-start gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-700">
                  <Sparkles className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>
                    <strong>Calculado de tu ejercicio {result.isr.coeficienteBase.year}:</strong>{" "}
                    {formatCurrency(result.isr.coeficienteBase.utilidad)} utilidad ÷{" "}
                    {formatCurrency(result.isr.coeficienteBase.ingresos)} ingresos ={" "}
                    <strong>{coeficiente != null ? (coeficiente * 100).toFixed(4) : "—"}%</strong>
                    {" "}({result.isr.coeficienteBase.invoiceCount} CFDIs en el sistema).
                    Puedes ajustarlo si tu declaración anual difiere.
                  </span>
                </div>
              </div>
            )}
            {result.isr.coeficienteFuente === "manual" && (
              <div className="px-5 pb-4">
                <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700">
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  Coeficiente guardado manualmente. Se usará para todos los meses de {year}.
                  Edítalo arriba si necesitas corregirlo.
                </div>
              </div>
            )}
            {result.isr.coeficienteFuente === "provisional_previo" && (
              <div className="px-5 pb-4">
                <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700">
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  Es el coeficiente que ya aplicaste en tus pagos provisionales de {year} (tomado
                  de un acuse del SAT). Edítalo arriba si tu declaración anual difiere.
                </div>
              </div>
            )}
            </>
            ) : (
            /* ── PF actividad empresarial / RESICO PF — server-computed ── */
            <div className="px-5 py-4 space-y-0.5">
              {isrComputed ? (
                result.isr.metodo === "PF_PLATAFORMAS" ? (
                  <>
                    <Row label={`Ingresos cobrados del mes (${MONTHS[month - 1]})`} value={formatCurrency(result.isr.ingresosAcumulados)} accent="blue" />
                    <Row label={`× Tasa ${result.isr.plataformaActividad?.label ?? ""} (${result.isr.tasa != null ? (result.isr.tasa * 100).toFixed(2) : "—"}%)`} value="" indent />
                    <Row label="= ISR causado" value={formatCurrency(isrComputed.isrDelEjercicio)} indent bold />
                    {result.isr.retencionesAcreditadas > 0 && (
                      <Row label="− Retenciones de plataformas" value={`(${formatCurrency(result.isr.retencionesAcreditadas)})`} />
                    )}
                    <Row label="= ISR del mes (definitivo)" value={formatCurrency(isrComputed.esteMes)} bold accent="purple" />
                    {result.isr.plataformaActividad?.asumida && (
                      <p className="pt-2 text-[11px] text-amber-600">
                        Tasa asumida (servicios/enajenación, 1%). Si la actividad es transporte (2.1%) u hospedaje (4%), configúrala en la empresa.
                      </p>
                    )}
                  </>
                ) : result.isr.metodo === "PF_ARRENDAMIENTO" ? (
                  <>
                    <Row label={`Ingresos cobrados del mes (${MONTHS[month - 1]})`} value={formatCurrency(result.isr.ingresosAcumulados)} accent="blue" />
                    <Row label="− Deducción ciega 35% (Art. 115)" value={`(${formatCurrency(result.isr.ingresosAcumulados * 0.35)})`} />
                    <Row label="= Base gravable" value={formatCurrency(isrComputed.baseGravable)} indent bold />
                    <Row label="× Tarifa mensual Art. 96 (progresiva)" value="" indent />
                    <Row label="= ISR causado" value={formatCurrency(isrComputed.isrDelEjercicio)} indent bold />
                    {result.isr.retencionesAcreditadas > 0 && (
                      <Row label="− Retenciones 10% PM (Art. 116)" value={`(${formatCurrency(result.isr.retencionesAcreditadas)})`} />
                    )}
                    <Row label="= ISR del mes" value={formatCurrency(isrComputed.esteMes)} bold accent="purple" />
                    <p className="pt-2 text-[11px] text-muted-foreground">
                      Deducción opcional ciega (Art. 115, sin predial). Si convienen las deducciones comprobadas, ajusta manualmente.
                    </p>
                  </>
                ) : result.isr.metodo === "RESICO_PF" ? (
                  <>
                    <Row label={`Ingresos del mes (${MONTHS[month - 1]})`} value={formatCurrency(result.isr.ingresosDelMes)} accent="blue" />
                    <Row label={`× Tasa RESICO (${result.isr.tasa != null ? (result.isr.tasa * 100).toFixed(2) : "—"}%)`} value="" indent />
                    <Row label="= ISR causado" value={formatCurrency(isrComputed.isrDelEjercicio)} indent bold />
                    {result.isr.retencionesAcreditadas > 0 && (
                      <Row label="− Retenciones 1.25% PM (Art. 113-J)" value={`(${formatCurrency(result.isr.retencionesAcreditadas)})`} />
                    )}
                    {result.isr.saldoFavorAnterior > 0 && (
                      <Row label="− Saldo a favor del periodo anterior" value={`(${formatCurrency(result.isr.saldoFavorAnterior)})`} />
                    )}
                    <Row label="= ISR del mes" value={formatCurrency(isrComputed.esteMes)} bold accent="purple" />
                    {result.isr.saldoAFavor > 0 && (
                      <div className="mt-2 flex items-start gap-2 bg-green-50 border border-green-200 rounded-lg px-3 py-2 text-xs text-green-700">
                        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        La retención acreditable excede el ISR del mes: <strong>{formatCurrency(result.isr.saldoAFavor)}</strong>{" "}
                        se arrastra como saldo a favor al siguiente periodo. Guarda la declaración para que el arrastre aplique.
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <Row
                      label={`Ingresos cobrados acum. ${MONTHS[0]}–${MONTHS[month - 1]} (${month} mes${month > 1 ? "es" : ""})`}
                      value={formatCurrency(result.isr.ingresosAcumulados)}
                      accent="blue"
                    />
                    <Row label="= Base gravable (ingresos cobrados − deducciones pagadas)" value={formatCurrency(isrComputed.baseGravable)} indent bold />
                    <Row label="× Tarifa Art. 96 (progresiva, elevada al periodo)" value="" indent />
                    <Row label="= ISR causado" value={formatCurrency(isrComputed.isrDelEjercicio)} indent bold />
                    {result.isr.isrPagadoAnterior > 0 && (
                      <Row
                        label={`− Pagos provisionales anteriores (${month - 1} pago${month > 2 ? "s" : ""})`}
                        value={`(${formatCurrency(result.isr.isrPagadoAnterior)})`}
                      />
                    )}
                    {result.isr.retencionesAcreditadas > 0 && (
                      <Row label="− Retenciones 10% PM (Art. 106)" value={`(${formatCurrency(result.isr.retencionesAcreditadas)})`} />
                    )}
                    <Row label="ISR a pagar este mes" value={formatCurrency(isrComputed.esteMes)} bold accent="purple" />
                  </>
                )
              ) : (
                <div className="mt-2 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  No hay tarifa ISR cargada para {year} en el módulo de tarifas. No es posible calcular el ISR de este régimen.
                </div>
              )}
            </div>
            )}
          </div>

          {/* ── Asimilados a salarios (Art. 94) — se reconoce solo ── */}
          {result.asimilados && (
            <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-border flex items-center gap-2 flex-wrap">
                <Receipt className="h-4 w-4 text-muted-foreground" />
                <h2 className="font-semibold text-sm">Asimilados a salarios</h2>
                <span className="ml-auto text-xs text-muted-foreground">
                  {result.asimilados.recibos.filter((r) => r.esDelMes).length} recibo(s) en {MONTHS[month - 1]}
                </span>
              </div>
              <div className="px-5 py-4">
                <Row label={`Ingresos del mes (${MONTHS[month - 1]})`} value={formatCurrency(result.asimilados.mes.ingreso)} accent="blue" />
                <Row label="ISR que te retuvieron (pago provisional)" value={formatCurrency(result.asimilados.mes.isrRetenido)} />
                <Row label={`Ingresos acumulados ${year}`} value={formatCurrency(result.asimilados.anual.ingreso)} bold />
                <Row label={`ISR que te retuvieron en ${year} (acreditable en la anual)`} value={formatCurrency(result.asimilados.anual.isrRetenido)} accent="green" />

                {result.asimilados.recibos.filter((r) => r.esDelMes).length > 0 && (
                  <div className="mt-3 border-t border-border divide-y divide-border">
                    {result.asimilados.recibos.filter((r) => r.esDelMes).map((r) => (
                      <div key={r.id} className="flex items-center justify-between gap-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{r.emisor}</p>
                          <p className="text-xs text-muted-foreground">{formatDate(r.fecha)} · {r.regimenLabel ?? "Asimilados"}</p>
                        </div>
                        <div className="text-right whitespace-nowrap">
                          <p className="text-sm font-medium">{formatCurrency(r.ingreso)}</p>
                          <p className="text-xs text-muted-foreground">ISR ret. {formatCurrency(r.isrRetenido)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <p className="mt-3 text-xs text-muted-foreground">
                  Ingresos por asimilados a salarios (Art. 94 LISR): el pagador retiene y entera el ISR — esa
                  retención es tu pago provisional, por eso <strong>no</strong> entra a la base de actividad
                  empresarial de arriba. Se acredita en tu <strong>declaración anual</strong>.
                </p>
              </div>
            </div>
          )}

          {/* ── Facturas del período ── */}
          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2 flex-wrap">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-semibold text-sm">Facturas de {MONTHS[month - 1]} {year}</h2>
              <span className="ml-auto text-xs text-muted-foreground">{result.facturas.length} factura(s)</span>
              <div className="flex gap-1">
                {(["all","INGRESO","EGRESO","NOMINA"] as const).map(f => (
                  <button key={f} onClick={() => setFacturaFilter(f)}
                    className={`px-2.5 py-0.5 rounded-full text-xs font-medium transition-colors ${
                      facturaFilter === f
                        ? "bg-primary text-primary-foreground"
                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}>
                    {f === "all" ? "Todas" : f === "INGRESO" ? "Emitidas" : f === "EGRESO" ? "Recibidas" : "Nómina"}
                  </button>
                ))}
              </div>
            </div>

            {filteredFacturas.length > 0 ? (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-gray-50">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground w-20">Tipo</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Fecha</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Contraparte</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Subtotal</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">IVA</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFacturas.map(f => (
                    <tr key={f.id} className="border-b border-border last:border-0 hover:bg-gray-50/50">
                      <td className="px-4 py-2.5">
                        {f.tipo === "INGRESO" ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-green-50 text-green-700">
                            <ArrowUpRight className="h-3 w-3" />Emitida
                          </span>
                        ) : f.tipo === "NOMINA" ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-blue-50 text-blue-700">
                            <ArrowDownLeft className="h-3 w-3" />Nómina
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-orange-50 text-orange-700">
                            <ArrowDownLeft className="h-3 w-3" />Recibida
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatDate(f.fecha)}</td>
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-xs">{f.contraparte}</p>
                        <p className="text-xs text-muted-foreground">{f.rfc}</p>
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs">{formatCurrency(f.subtotal)}</td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{formatCurrency(f.iva)}</td>
                      <td className={`px-4 py-2.5 text-right text-xs font-semibold ${f.tipo === "INGRESO" ? "text-green-700" : f.tipo === "NOMINA" ? "text-blue-700" : "text-orange-700"}`}>
                        {f.tipo !== "INGRESO" ? "(" : ""}{formatCurrency(f.total)}{f.tipo !== "INGRESO" ? ")" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t border-border">
                    <td colSpan={3} className="px-4 py-2.5 text-xs font-semibold">Totales ({filteredFacturas.length})</td>
                    <td className="px-4 py-2.5 text-right text-xs font-semibold">{formatCurrency(filteredFacturas.reduce((s,f) => s + f.subtotal, 0))}</td>
                    <td className="px-4 py-2.5 text-right text-xs font-semibold">{formatCurrency(filteredFacturas.reduce((s,f) => s + f.iva, 0))}</td>
                    <td className="px-4 py-2.5 text-right text-xs font-semibold">{formatCurrency(filteredFacturas.reduce((s,f) => s + f.total, 0))}</td>
                  </tr>
                </tfoot>
              </table>
            ) : (
              <div className="p-10 text-center">
                <TrendingDown className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-30" />
                <p className="font-medium text-sm">Sin facturas en este período</p>
                <p className="text-xs text-muted-foreground mt-1">
                  No hay CFDIs en {MONTHS[month - 1]} {year}
                </p>
              </div>
            )}
          </div>

          {/* ── SAT Sync ── */}
          <div className="bg-white rounded-xl border border-border shadow-sm p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold text-sm">Sincronizar CFDIs del SAT</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Descarga tus facturas emitidas y recibidas directamente del SAT usando tu e.firma.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button onClick={() => handleSatSync(false)} disabled={syncing}
                  className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors">
                  {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  {syncing ? "Sincronizando..." : "Sincronizar CFDIs"}
                </button>
                <button
                  onClick={() => handleSatSync(true)}
                  disabled={syncing}
                  title="Forzar nueva solicitud al SAT (ignora solicitudes pendientes)"
                  className="text-xs px-2.5 py-2 rounded-md border border-border hover:bg-accent disabled:opacity-50 text-muted-foreground"
                >
                  Forzar
                </button>
              </div>
            </div>
            {(syncing || syncStatus) && (
              <div className={`mt-3 flex items-center gap-2 text-xs px-3 py-2 rounded-md ${
                syncDone
                  ? "bg-green-50 text-green-700 border border-green-200"
                  : syncing
                  ? "bg-blue-50 text-blue-700 border border-blue-200"
                  : "bg-gray-50 text-muted-foreground border border-border"
              }`}>
                {syncing && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
                {syncDone && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
                {syncStatus}
              </div>
            )}

            {/* SAT request history for the period */}
            {satRequests.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                  Solicitudes con SAT (este período)
                </p>
                <div className="border border-border rounded-md divide-y divide-border overflow-hidden">
                  {satRequests.map(r => {
                    const lv = r.lastVerifiedAt ? new Date(r.lastVerifiedAt) : null;
                    const lvStr = lv ? `${Math.max(0, Math.round((Date.now() - lv.getTime()) / 60000))} min` : null;
                    return (
                      <div key={r.id} className="px-3 py-2 flex items-center gap-3 text-xs">
                        <span className="font-medium w-20 text-muted-foreground">
                          {r.tipo === "EMITIDOS" ? "Emitidos" : "Recibidos"}
                        </span>
                        <span className={`px-2 py-0.5 rounded font-medium ${SAT_STATUS_COLORS[r.status] ?? "bg-gray-100"}`}>
                          {SAT_STATUS_LABELS[r.status] ?? r.status}
                        </span>
                        <span className="text-muted-foreground flex-1 truncate">
                          {r.cfdisFound > 0 && `${r.cfdisFound} CFDIs`}
                          {r.imported > 0 && ` · ${r.imported} importados`}
                          {r.errorMessage && ` · ${r.errorMessage}`}
                        </span>
                        {lvStr && (
                          <span className="text-muted-foreground text-[10px]">hace {lvStr}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="text-[10px] text-muted-foreground mt-1.5">
                  Las solicitudes pendientes se reusan automáticamente. Si SAT te dio el código 5002, espera a que las solicitudes vencidas se procesen (1-3 hrs) — no necesitas hacer nada.
                </p>
              </div>
            )}
          </div>

          {/* ── Acuse de recibo / Línea de captura ── */}
          {(savedStatus === "FILED" || savedStatus === "PAID") && (
            <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-border flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="h-8 w-8 rounded-lg bg-green-100 flex items-center justify-center">
                    <Receipt className="h-4 w-4 text-green-600" />
                  </div>
                  <div>
                    <h2 className="font-semibold text-sm">Acuse de recibo &amp; Línea de captura</h2>
                    <p className="text-xs text-muted-foreground">Información del pago al SAT</p>
                  </div>
                </div>
                {!acuseEditMode && (acuseUrl || lineaCaptura) && (
                  <button onClick={() => setAcuseEditMode(true)}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md px-2.5 py-1 transition-colors">
                    <Pencil className="h-3 w-3" />Editar
                  </button>
                )}
              </div>

              {acuseEditMode ? (
                <div className="px-5 py-4 space-y-4">
                  {/* Folio / número de operación */}
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1">
                      Número de operación / Folio SAT
                    </label>
                    <input
                      type="text"
                      value={acuseUrl}
                      onChange={e => setAcuseUrl(e.target.value)}
                      placeholder="Ej. 2024010123456789"
                      className="w-full text-sm border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                    <p className="text-xs text-muted-foreground mt-0.5">Número de acuse que el SAT te asignó al presentar la declaración.</p>
                  </div>

                  {/* Línea de captura */}
                  <div>
                    <label className="block text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1.5">
                      <CreditCard className="h-3.5 w-3.5" />Línea de captura
                    </label>
                    <input
                      type="text"
                      value={lineaCaptura}
                      onChange={e => setLineaCaptura(e.target.value.replace(/\D/g, "").substring(0, 20))}
                      placeholder="18 dígitos"
                      className="w-full text-sm font-mono border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary tracking-widest"
                    />
                    <p className="text-xs text-muted-foreground mt-0.5">Código numérico para pagar en banco o portal bancario.</p>
                  </div>

                  {/* Dates */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1.5">
                        <Calendar className="h-3.5 w-3.5" />Fecha de presentación
                      </label>
                      <input
                        type="date"
                        value={fechaPresentacion}
                        onChange={e => setFechaPresentacion(e.target.value)}
                        className="w-full text-sm border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-muted-foreground mb-1 flex items-center gap-1.5">
                        <Calendar className="h-3.5 w-3.5" />Fecha límite de pago
                      </label>
                      <input
                        type="date"
                        value={fechaLimitePago}
                        onChange={e => setFechaLimitePago(e.target.value)}
                        className="w-full text-sm border border-border rounded-md px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button onClick={handleGuardarAcuse} disabled={savingAcuse}
                      className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-1.5 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors">
                      {savingAcuse ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      Guardar acuse
                    </button>
                    {(acuseUrl || lineaCaptura) && (
                      <button onClick={() => setAcuseEditMode(false)}
                        className="text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 transition-colors">
                        Cancelar
                      </button>
                    )}
                  </div>
                </div>
              ) : (acuseUrl || lineaCaptura) ? (
                <div className="px-5 py-4 space-y-3">
                  {acuseUrl && (
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Número de operación</span>
                      <span className="text-sm font-mono font-medium">{acuseUrl}</span>
                    </div>
                  )}
                  {lineaCaptura && (
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <CreditCard className="h-3 w-3" />Línea de captura
                      </span>
                      <div className="text-right">
                        <span className="text-sm font-mono font-bold tracking-widest text-blue-700 bg-blue-50 px-2 py-0.5 rounded">
                          {lineaCaptura}
                        </span>
                        {fechaLimitePago && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Vigente hasta {new Date(fechaLimitePago + "T12:00:00").toLocaleDateString("es-MX", { day: "2-digit", month: "long", year: "numeric" })}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                  {fechaPresentacion && (
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Fecha de presentación</span>
                      <span className="text-sm">
                        {new Date(fechaPresentacion + "T12:00:00").toLocaleDateString("es-MX", { day: "2-digit", month: "long", year: "numeric" })}
                      </span>
                    </div>
                  )}
                  {/* Link to SAT payment portal */}
                  {lineaCaptura && (
                    <div className="pt-1 border-t border-border">
                      <a
                        href="https://www.sat.gob.mx/tramites/liquidacion-de-impuestos-en-linea"
                        target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 hover:underline">
                        <ExternalLink className="h-3 w-3" />
                        Pagar en el portal SAT
                      </a>
                      <span className="text-xs text-muted-foreground ml-3">o en cualquier banco con esta línea de captura</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="px-5 py-4">
                  <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-3 text-xs text-blue-700">
                    <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <div>
                      <p className="font-medium mb-1">¿Ya presentaste tu declaración?</p>
                      <p>Registra el número de operación y la línea de captura del acuse del SAT para llevar un control completo de tus pagos.</p>
                      <button onClick={() => setAcuseEditMode(true)}
                        className="mt-2 flex items-center gap-1 font-medium hover:underline">
                        <Receipt className="h-3 w-3" />Registrar acuse
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Actions ── */}
          <div className="flex items-center gap-3 pb-2">
            <button onClick={() => handleGuardar("CALCULATED")} disabled={saving}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Guardar declaración
            </button>
            <button onClick={() => handleGuardar("FILED")} disabled={saving}
              className="flex items-center gap-2 border border-border px-4 py-2 rounded-md text-sm font-medium hover:bg-accent disabled:opacity-50 transition-colors">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Marcar como presentada
            </button>
          </div>

        </div>
      ) : null}
    </div>
  );
}

// ── Projection card ─────────────────────────────────────────────────────────
// Simulates the impact of an additional ingreso or gasto on the current month's
// IVA and ISR. Delegates to /api/impuestos/simular so the ISR delta is computed
// with the company's REAL régimen math — e.g. in PF Art. 106 a paid gasto reduces
// the flujo base (ISR drops), while in PM Art. 14 it doesn't. Never a hardcoded
// per-régimen assumption.
interface SimResult {
  base: { iva: number; isr: number | null; total: number };
  sim: { iva: number; ivaSaldoFavor: number; isr: number | null; total: number };
  metodo: string;
  tarifaVerificada: boolean;
}

// Nota por régimen — cómo se mueve el ISR provisional con el delta.
const SIM_NOTA: Record<string, string> = {
  PM_ART14: "PM (Art. 14): el ingreso sube el provisional vía coeficiente; los gastos no lo reducen este mes (sólo el coeficiente del año siguiente).",
  PF_ACT_EMPRESARIAL: "PF actividad empresarial (Art. 106): base de flujo — el ingreso cobrado la sube y el gasto pagado la reduce.",
  RESICO_PF: "RESICO (Art. 113-E): el ISR es sobre ingresos cobrados; los gastos no lo reducen.",
  PF_ARRENDAMIENTO: "Arrendamiento (Art. 115): la deducción es ciega (35%); un gasto adicional no cambia el ISR.",
  PF_PLATAFORMAS: "Plataformas (Art. 113-A): el ISR es tasa fija sobre ingresos; los gastos no lo reducen.",
};

function ProjectionCard({
  companyId,
  month,
  year,
  projIngresoAdicional,
  projGastoAdicional,
  onIngresoChange,
  onGastoChange,
}: {
  companyId: string;
  month: number;
  year: number;
  projIngresoAdicional: string;
  projGastoAdicional: string;
  onIngresoChange: (v: string) => void;
  onGastoChange: (v: string) => void;
}) {
  const addIngreso = parseFloat(projIngresoAdicional) || 0;
  const addGasto = parseFloat(projGastoAdicional) || 0;
  const hasProjection = addIngreso > 0 || addGasto > 0;

  const [sim, setSim] = useState<SimResult | null>(null);
  const [loading, setLoading] = useState(false);

  // Debounced: re-run the real fiscal engine for the period with the deltas.
  useEffect(() => {
    if (!hasProjection) { setSim(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          companyId, month: String(month), year: String(year),
          addIngreso: String(addIngreso), addGasto: String(addGasto),
        });
        const res = await fetch(`/api/impuestos/simular?${params}`);
        const data = await res.json();
        if (!cancelled) setSim(res.ok ? data : null);
      } catch {
        if (!cancelled) setSim(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [companyId, month, year, addIngreso, addGasto, hasProjection]);

  const ivaAddedTrasladado = addIngreso * 0.16;
  const ivaAddedAcreditable = addGasto * 0.16;
  const deltaIva = sim ? sim.sim.iva - sim.base.iva : 0;
  const deltaIsr = sim && sim.sim.isr != null && sim.base.isr != null ? sim.sim.isr - sim.base.isr : 0;
  const deltaTotal = sim ? sim.sim.total - sim.base.total : 0;

  return (
    <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <div className="h-8 w-8 rounded-lg bg-indigo-100 flex items-center justify-center">
          <Sparkles className="h-4 w-4 text-indigo-600" />
        </div>
        <div>
          <h2 className="font-semibold text-sm">Simulación fiscal</h2>
          <p className="text-xs text-muted-foreground">Proyecta el impacto de ingresos o gastos adicionales</p>
        </div>
      </div>
      <div className="p-5">
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-xs font-medium mb-1 text-muted-foreground">
              + Ingreso adicional (subtotal, sin IVA)
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={projIngresoAdicional}
              onChange={(e) => onIngresoChange(e.target.value)}
              placeholder="0.00"
              className="w-full px-3 py-2 border border-border rounded-md text-sm font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1 text-muted-foreground">
              + Gasto adicional con CFDI (subtotal, sin IVA)
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={projGastoAdicional}
              onChange={(e) => onGastoChange(e.target.value)}
              placeholder="0.00"
              className="w-full px-3 py-2 border border-border rounded-md text-sm font-mono"
            />
          </div>
        </div>

        {!hasProjection ? (
          <p className="text-xs text-muted-foreground">
            Escribe un monto arriba para ver el impacto en tu IVA e ISR del mes.
          </p>
        ) : loading || !sim ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Calculando impacto…
          </div>
        ) : (
          <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 text-sm">
            <p className="font-semibold text-indigo-900 mb-3">Impacto proyectado:</p>
            <dl className="space-y-1.5 font-mono text-xs">
              <div className="flex justify-between">
                <dt className="text-indigo-700">IVA trasladado adicional</dt>
                <dd className="font-medium">+{formatCurrency(ivaAddedTrasladado)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-indigo-700">IVA acreditable adicional</dt>
                <dd className="font-medium">+{formatCurrency(ivaAddedAcreditable)}</dd>
              </div>
              <div className="flex justify-between border-t border-indigo-200 pt-1.5 mt-1.5">
                <dt className="text-indigo-900 font-semibold">IVA a pagar actual</dt>
                <dd className="font-medium">{formatCurrency(sim.base.iva)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-indigo-900 font-semibold">IVA a pagar proyectado</dt>
                <dd className={`font-bold ${deltaIva >= 0 ? "text-red-700" : "text-green-700"}`}>
                  {formatCurrency(sim.sim.iva)}
                  <span className="ml-2 text-xs">({deltaIva >= 0 ? "+" : ""}{formatCurrency(deltaIva)})</span>
                </dd>
              </div>
              {sim.sim.ivaSaldoFavor > 0 && (
                <div className="flex justify-between text-green-700">
                  <dt>Saldo a favor de IVA proyectado</dt>
                  <dd className="font-semibold">{formatCurrency(sim.sim.ivaSaldoFavor)}</dd>
                </div>
              )}
              {sim.base.isr != null && sim.sim.isr != null && (
                <>
                  <div className="flex justify-between border-t border-indigo-200 pt-1.5 mt-1.5">
                    <dt className="text-indigo-900 font-semibold">ISR provisional actual</dt>
                    <dd className="font-medium">{formatCurrency(sim.base.isr)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-indigo-900 font-semibold">ISR provisional proyectado</dt>
                    <dd className={`font-bold ${deltaIsr >= 0 ? "text-red-700" : "text-green-700"}`}>
                      {formatCurrency(sim.sim.isr)}
                      <span className="ml-2 text-xs">({deltaIsr >= 0 ? "+" : ""}{formatCurrency(deltaIsr)})</span>
                    </dd>
                  </div>
                </>
              )}
              <div className="flex justify-between border-t border-indigo-200 pt-1.5 mt-1.5">
                <dt className="text-indigo-900 font-semibold">Total actual</dt>
                <dd className="font-medium">{formatCurrency(sim.base.total)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-indigo-900 font-semibold">Total proyectado</dt>
                <dd className={`font-bold ${deltaTotal >= 0 ? "text-red-700" : "text-green-700"}`}>
                  {formatCurrency(sim.sim.total)}
                  <span className="ml-2 text-xs">({deltaTotal >= 0 ? "+" : ""}{formatCurrency(deltaTotal)})</span>
                </dd>
              </div>
            </dl>
            <p className="text-[10px] text-indigo-700 mt-3">
              Asume IVA 16% en ambos conceptos. ISR según tu régimen: {SIM_NOTA[sim.metodo] ?? "se recalcula con el método de tu régimen."}
              {!sim.tarifaVerificada && " (tarifa ISR del ejercicio sin verificar)"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
