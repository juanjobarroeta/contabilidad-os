"use client";

import { descargarUrl } from "@/lib/descargar";

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña Corridas del hub de Nómina — el workspace power-user que antes vivía
// en /nomina/detalle: lista de corridas (con las importadas del SAT en sólo
// lectura), prefill «Iniciar desde la quincena anterior», desglose por
// empleado, captura de incidencias con recálculo automático, timbrado y
// dispersión. La sección «Incidencias del periodo» (antes pestaña propia del
// workspace) vive al final, con su selector de mes. Lógica sin cambios.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Alert, Money, RetryButton } from "@/components/ui";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Plus, Loader2, X, AlertCircle, CheckCircle2, Play, Calendar, ClipboardList,
  ArrowLeftRight, ChevronDown, ChevronUp, Trash2, History, RefreshCw, Gift, Coins, Sparkles, Ban,
} from "lucide-react";
import { RepresentacionImpresa } from "@/components/facturas/RepresentacionImpresa";
import {
  TIPO_RUN_LABEL, STATUS_RUN_LABEL, STATUS_RUN_COLOR,
  INCIDENCIA_LABEL,
  percepExtra,
  type Employee, type PayrollRun, type PayrollItemDetail,
  type RunPrefill, type Incidencia, type RunIncidencia,
} from "./workspace-shared";
import {
  NewRunModal, NewIncidenciaModal, RunIncidenciasModal,
  AguinaldoRunModal, PtuRunModal,
} from "./RunModals";

// Fecha corta de periodo para móvil: "2026-07-01/2026-07-15" → "1–15 jul 2026".
// Si el formato no es el esperado, regresa la cadena original.
const MESES_CORTOS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
function fmtPeriodoCorto(periodo: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})\/(\d{4})-(\d{2})-(\d{2})$/.exec(periodo);
  if (!m) return periodo;
  const [, y1, m1, d1, y2, m2, d2] = m;
  const dia1 = parseInt(d1), dia2 = parseInt(d2);
  const mes1 = MESES_CORTOS[parseInt(m1) - 1], mes2 = MESES_CORTOS[parseInt(m2) - 1];
  if (y1 === y2 && m1 === m2) return `${dia1}–${dia2} ${mes1} ${y1}`;
  if (y1 === y2) return `${dia1} ${mes1} – ${dia2} ${mes2} ${y1}`;
  return `${dia1} ${mes1} ${y1} – ${dia2} ${mes2} ${y2}`;
}

export default function CorridasTab() {
  const { activeCompany } = useCompany();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState("");
  // Error de carga del roster (alimenta la captura de incidencias).
  const [empError, setEmpError] = useState(false);

  // Corridas state. runsLoading arranca en true: antes de la primera carga la
  // pantalla NO debe verse como «Sin corridas» (no-cargado ≠ vacío).
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  // Fetch de corridas fallido — se muestra error con reintento, no el vacío.
  const [runsError, setRunsError] = useState(false);
  const [showNewRun, setShowNewRun] = useState(false);
  // Corridas especiales de un toque: menú + modal de aguinaldo / PTU.
  const [especialMenuOpen, setEspecialMenuOpen] = useState(false);
  const [showAguinaldo, setShowAguinaldo] = useState(false);
  const [showPtu, setShowPtu] = useState(false);
  const [runPrefill, setRunPrefill] = useState<RunPrefill | null>(null);
  const [prefillLoading, setPrefillLoading] = useState(false);
  const [stampingId, setStampingId] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runItems, setRunItems] = useState<PayrollItemDetail[]>([]);
  const [runItemsLoading, setRunItemsLoading] = useState(false);
  // Drill-in fallido: sin esto, una corrida con error de red se vería VACÍA.
  const [runItemsError, setRunItemsError] = useState(false);
  // Incidencias del periodo de la corrida expandida + item con el modal abierto.
  const [runIncidencias, setRunIncidencias] = useState<RunIncidencia[]>([]);
  const [incForItem, setIncForItem] = useState<PayrollItemDetail | null>(null);

  // Representación impresa del recibo (funciona también para los importados del
  // SAT: se renderiza desde el XML guardado, con "Imprimir / Guardar PDF").
  const [repInvoiceId, setRepInvoiceId] = useState<string | null>(null);
  // Vista previa BORRADOR de un recibo calculado sin timbrar (marca de agua).
  const [previewItemId, setPreviewItemId] = useState<string | null>(null);
  // Cancelación de un timbre ante el SAT (sólo recibos emitidos por la app).
  const [cancelCtx, setCancelCtx] = useState<{ item: PayrollItemDetail; runId: string } | null>(null);
  const [cancelMotivo, setCancelMotivo] = useState("02");
  const [cancelSustituye, setCancelSustituye] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelErr, setCancelErr] = useState("");

  // Incidencias state (sección «Incidencias del periodo»)
  const [incidencias, setIncidencias] = useState<Incidencia[]>([]);
  const [incLoading, setIncLoading] = useState(true);
  const [incError, setIncError] = useState(false);
  const [showNewInc, setShowNewInc] = useState(false);
  const now = new Date();
  const [incPeriodo, setIncPeriodo] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);

  const loadEmployees = useCallback(async () => {
    if (!activeCompany) return;
    setEmpError(false);
    try {
      const res = await fetch(`/api/empleados?companyId=${activeCompany.id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEmployees(Array.isArray(data) ? data : []);
    } catch { setEmpError(true); }
  }, [activeCompany]);

  const loadRuns = useCallback(async () => {
    if (!activeCompany) return;
    setRunsLoading(true);
    setRunsError(false);
    try {
      const res = await fetch(`/api/nomina/run?companyId=${activeCompany.id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRuns(Array.isArray(data) ? data : []);
    } catch { setRunsError(true); }
    finally { setRunsLoading(false); }
  }, [activeCompany]);

  const loadIncidencias = useCallback(async () => {
    if (!activeCompany) return;
    setIncLoading(true);
    setIncError(false);
    try {
      const res = await fetch(`/api/nomina/incidencias?companyId=${activeCompany.id}&periodo=${incPeriodo}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setIncidencias(data.incidencias ?? []);
    } catch { setIncError(true); }
    finally { setIncLoading(false); }
  }, [activeCompany, incPeriodo]);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);
  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => { loadIncidencias(); }, [loadIncidencias]);

  async function doCancelTimbre() {
    if (!activeCompany || !cancelCtx) return;
    setCancelBusy(true);
    setCancelErr("");
    try {
      const res = await fetch("/api/nomina/recibos/cancelar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: activeCompany.id,
          payrollItemId: cancelCtx.item.id,
          motivo: cancelMotivo,
          ...(cancelMotivo === "01" ? { sustituyeUuid: cancelSustituye.trim() } : {}),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "No se pudo cancelar el recibo");
      const runId = cancelCtx.runId;
      setCancelCtx(null);
      setCancelSustituye("");
      setCancelMotivo("02");
      await Promise.all([loadRuns(), loadRunDetail(runId)]);
    } catch (e) {
      setCancelErr(e instanceof Error ? e.message : "No se pudo cancelar el recibo");
    } finally {
      setCancelBusy(false);
    }
  }

  const loadRunDetail = useCallback(async (runId: string) => {
    setRunItemsLoading(true);
    setRunItemsError(false);
    try {
      const res = await fetch(`/api/nomina/run/${runId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRunItems(data.items ?? []);
      setRunIncidencias(data.incidencias ?? []);
    } catch {
      // Error ≠ corrida vacía: se limpia lo viejo y se muestra error + reintentar.
      setRunItems([]);
      setRunIncidencias([]);
      setRunItemsError(true);
    }
    finally { setRunItemsLoading(false); }
  }, []);

  function toggleRunDetail(runId: string) {
    if (expandedRunId === runId) { setExpandedRunId(null); return; }
    setExpandedRunId(runId);
    setRunItems([]);
    setRunIncidencias([]);
    loadRunDetail(runId);
  }

  // Recalcular toda la corrida con las incidencias vigentes del periodo (útil
  // tras capturas masivas). El motor rehace ISR/IMSS/INFONAVIT — nada a mano.
  const [recalcId, setRecalcId] = useState<string | null>(null);
  async function handleRecalc(runId: string) {
    setRecalcId(runId);
    setError("");
    try {
      const res = await fetch(`/api/nomina/run/${runId}/recalcular`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Error al recalcular"); return; }
      setError(`✓ Corrida recalculada (${data.recalculados} empleado${data.recalculados === 1 ? "" : "s"})${data.tarifaWarning ? ` — ${data.tarifaWarning}` : ""}`);
      loadRuns();
      if (expandedRunId === runId) loadRunDetail(runId);
    } catch { setError("Error al recalcular"); }
    finally { setRecalcId(null); }
  }

  async function handleDeleteRun(runId: string) {
    if (!confirm("¿Eliminar esta corrida? Los cálculos se perderán.")) return;
    try {
      const res = await fetch(`/api/nomina/run/${runId}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Error al eliminar"); return; }
      setError("✓ Corrida eliminada");
      loadRuns();
    } catch { setError("Error al eliminar"); }
  }

  // "Iniciar desde la quincena anterior": pide al servidor los insumos de la
  // siguiente corrida (periodo avanzado + empleados de la anterior) y abre el
  // modal prellenado. El cálculo de ISR/IMSS lo rehace el motor al crear.
  async function handlePrefillRun() {
    if (!activeCompany) return;
    setPrefillLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/nomina/run/prefill?companyId=${activeCompany.id}`);
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "No se pudo prellenar la corrida"); return; }
      setRunPrefill(data);
      setShowNewRun(true);
    } catch { setError("No se pudo prellenar la corrida"); }
    finally { setPrefillLoading(false); }
  }

  // Confirmación de timbrado con fecha de emisión del CFDI elegible (regla
  // SAT: máx. 72 h atrás — el mes fiscal lo fija la FechaPago de la corrida).
  const [stampForRun, setStampForRun] = useState<PayrollRun | null>(null);
  const hoyStr = new Date().toLocaleDateString("en-CA");
  const [stampFecha, setStampFecha] = useState(hoyStr);

  async function handleStamp(runId: string, fechaCfdi?: string) {
    setStampingId(runId);
    setError("");
    try {
      const conFecha = fechaCfdi && fechaCfdi !== hoyStr;
      const res = await fetch(`/api/nomina/run/${runId}/stamp`, {
        method: "POST",
        ...(conFecha
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fechaCfdi }) }
          : {}),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Error al timbrar");
      } else if (data.errors?.length) {
        setError(`Timbrado: ${data.stamped}/${data.total} OK. Errores: ${data.errors.join("; ")}`);
      } else {
        setError(`✓ ${data.stamped} recibos timbrados exitosamente`);
      }
      loadRuns();
      if (expandedRunId === runId) loadRunDetail(runId);
    } catch { setError("Error al timbrar"); }
    finally { setStampingId(null); }
  }

  if (!activeCompany) {
    return <div className="p-8 text-cos-ink-soft text-sm">Selecciona una empresa para ver su nómina.</div>;
  }

  return (
    <div className="p-4 sm:p-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold">Corridas de nómina</h1>
          <p className="text-sm text-cos-ink-soft mt-0.5">{activeCompany.razonSocial}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={handlePrefillRun} disabled={prefillLoading}
            className="flex items-center gap-2 border border-cos-line px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-paper disabled:opacity-50"
            title="Prellena la siguiente corrida con los empleados y el periodo que sigue a la corrida ordinaria más reciente">
            {prefillLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}
            Iniciar desde la quincena anterior
          </button>
          {/* Corrida especial: aguinaldo (temporada nov-dic, Art. 87 LFT) y
              PTU (temporada abr-jun, Arts. 117-127 LFT) de un toque. */}
          {(() => {
            const mes = new Date().getMonth() + 1; // 1-12
            const temporadaAguinaldo = mes === 11 || mes === 12;
            const temporadaPtu = mes >= 4 && mes <= 6;
            return (
              <div className="relative">
                <button onClick={() => setEspecialMenuOpen(o => !o)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border ${
                    temporadaAguinaldo || temporadaPtu
                      ? "border-cos-amber-ink/30 bg-cos-amber-tint text-cos-amber-ink hover:opacity-90"
                      : "border-cos-line hover:bg-cos-paper"
                  }`}
                  title="Corridas de aguinaldo y PTU de un toque, con vista previa por empleado">
                  <Sparkles className="h-4 w-4" /> Corrida especial <ChevronDown className="h-3.5 w-3.5" />
                </button>
                {especialMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setEspecialMenuOpen(false)} />
                    <div className="absolute right-0 mt-1 z-20 bg-cos-card border border-cos-line rounded-lg shadow-lg w-72 max-w-[calc(100vw-2rem)] overflow-hidden">
                      <button onClick={() => { setEspecialMenuOpen(false); setShowAguinaldo(true); }}
                        className={`w-full text-left px-4 py-3 hover:bg-cos-paper flex items-start gap-3 ${temporadaAguinaldo ? "bg-cos-amber-tint/40" : ""}`}>
                        <Gift className="h-4 w-4 mt-0.5 shrink-0 text-cos-ink-soft" />
                        <span>
                          <span className="block text-sm font-medium">
                            Aguinaldo
                            {temporadaAguinaldo && <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] bg-cos-amber-tint text-cos-amber-ink font-medium">Temporada</span>}
                          </span>
                          <span className="block text-xs text-cos-ink-soft mt-0.5">Mínimo 15 días de salario, antes del 20-dic (Art. 87 LFT)</span>
                        </span>
                      </button>
                      <button onClick={() => { setEspecialMenuOpen(false); setShowPtu(true); }}
                        className={`w-full text-left px-4 py-3 hover:bg-cos-paper flex items-start gap-3 border-t border-cos-line ${temporadaPtu ? "bg-cos-amber-tint/40" : ""}`}>
                        <Coins className="h-4 w-4 mt-0.5 shrink-0 text-cos-ink-soft" />
                        <span>
                          <span className="block text-sm font-medium">
                            PTU (reparto de utilidades)
                            {temporadaPtu && <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] bg-cos-amber-tint text-cos-amber-ink font-medium">Temporada</span>}
                          </span>
                          <span className="block text-xs text-cos-ink-soft mt-0.5">Mitad por días, mitad por salarios (Arts. 117-127 LFT)</span>
                        </span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })()}
          <button onClick={() => { setRunPrefill(null); setShowNewRun(true); }} className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep">
            <Plus className="h-4 w-4" /> Nueva corrida
          </button>
        </div>
      </div>

      {error && (
        <div className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm mb-4 ${
          error.startsWith("✓") ? "bg-cos-jade-tint border border-cos-jade-ink/20 text-cos-jade-ink" : "bg-cos-red-tint border border-cos-red-ink/20 text-cos-red-ink"
        }`}>
          {error.startsWith("✓") ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {empError && (
        <Alert tone="danger" className="mb-4" action={<RetryButton onClick={loadEmployees} />}>
          No se pudo cargar la lista de empleados — la captura de incidencias la necesita.
        </Alert>
      )}

    {runsLoading ? (
      <div className="flex items-center gap-2 text-cos-ink-soft text-sm py-12 justify-center">
        <Loader2 className="h-5 w-5 animate-spin" /> Cargando corridas...
      </div>
    ) : runsError ? (
      <Alert tone="danger" action={<RetryButton onClick={loadRuns} />}>
        No se pudieron cargar las corridas. Revisa tu conexión e inténtalo de nuevo.
      </Alert>
    ) : runs.length === 0 ? (
      <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-12 text-center">
        <Calendar className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
        <p className="font-medium text-sm">Sin corridas de nómina</p>
        <p className="text-xs text-cos-ink-soft mt-1">Crea una corrida para calcular y timbrar la nómina de todos los empleados.</p>
      </div>
    ) : (
      <div className="space-y-3">
        {runs.map(run => {
          const isExpanded = expandedRunId === run.id;
          // Captura de incidencias: sólo corridas ordinarias de la app
          // que aún no se timbran (los CFDIs emitidos no cambian).
          const puedeCapturar = (run.status === "DRAFT" || run.status === "CALCULATED")
            && run.origen !== "SAT" && run.tipo === "ORDINARIA";
          const numEmpleadosConInc = isExpanded
            ? new Set(runIncidencias.map(i => i.employeeId)).size
            : 0;
          return (
            <div key={run.id} className="bg-cos-card border border-cos-line rounded-xl overflow-hidden">
              {/* Run header — clickable to expand. En móvil se apila: info arriba,
                  botones con wrap abajo; en sm+ vuelve a ser una sola fila. */}
              <div className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 cursor-pointer hover:bg-cos-slate-tint/50" onClick={() => toggleRunDetail(run.id)}>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="font-semibold text-sm">{TIPO_RUN_LABEL[run.tipo] ?? run.tipo}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_RUN_COLOR[run.status] ?? "bg-cos-slate-tint"}`}>
                      {STATUS_RUN_LABEL[run.status] ?? run.status}
                    </span>
                    {run.origen === "SAT" && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-cos-slate-tint text-cos-ink-soft"
                        title="Reconstruida desde tus recibos de nómina timbrados en el SAT — histórico de sólo lectura">
                        Importada del SAT
                      </span>
                    )}
                    {run.extraData && !!(run.extraData as Record<string, unknown>).stampingInProgress && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-cos-amber-tint text-cos-amber-ink flex items-center gap-1">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        Timbrado {String((run.extraData as Record<string, unknown>).stampedCount ?? 0)}/{String(run._count?.items ?? "?")}
                      </span>
                    )}
                    {isExpanded && runIncidencias.length > 0 && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-cos-amber-tint text-cos-amber-ink"
                        title="Incidencias del periodo capturadas para esta corrida">
                        {runIncidencias.length} incidencia{runIncidencias.length === 1 ? "" : "s"} en {numEmpleadosConInc} empleado{numEmpleadosConInc === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-cos-ink-soft whitespace-nowrap" title={run.periodo}>{fmtPeriodoCorto(run.periodo)}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-xs">
                    <span>Empleados: <strong>{run._count?.items ?? "—"}</strong></span>
                    <span>Percepciones: <strong><Money value={run.totalPercepciones} /></strong></span>
                    <span>Deducciones: <strong><Money value={run.totalDeducciones} /></strong></span>
                    <span>Neto: <strong className="text-cos-jade-ink">{formatCurrency(run.totalNeto)}</strong></span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:shrink-0" onClick={e => e.stopPropagation()}>
                  {puedeCapturar && (
                    <button onClick={() => handleRecalc(run.id)} disabled={recalcId === run.id}
                      className="flex items-center gap-1.5 border border-cos-line px-3 py-1.5 rounded-md text-xs hover:bg-cos-paper disabled:opacity-50"
                      title="Recalcular todos los recibos con las incidencias vigentes del periodo">
                      {recalcId === run.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      Recalcular
                    </button>
                  )}
                  {run.status === "CALCULATED" && (
                    <button onClick={() => { setStampFecha(hoyStr); setStampForRun(run); }} disabled={stampingId === run.id}
                      className="flex items-center gap-1.5 bg-cos-jade-ink text-white px-3 py-1.5 rounded-md text-xs font-medium hover:opacity-90 disabled:opacity-50">
                      {stampingId === run.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      Timbrar todo
                    </button>
                  )}
                  {/* Las corridas importadas del SAT ya se pagaron en su momento —
                      sin re-timbrado ni dispersión (histórico de sólo lectura). */}
                  {(run.status === "STAMPED" || run.status === "CALCULATED") && run.origen !== "SAT" && (
                    <a href={`/api/nomina/dispersion?runId=${run.id}`}
                      className="flex items-center gap-1.5 border border-cos-line px-3 py-1.5 rounded-md text-xs hover:bg-cos-paper">
                      <ArrowLeftRight className="h-3.5 w-3.5" /> Dispersión
                    </a>
                  )}
                  {(run.status === "DRAFT" || run.status === "CALCULATED") && (
                    <button onClick={() => handleDeleteRun(run.id)}
                      className="flex items-center gap-1 border border-cos-red-ink/20 text-cos-red-ink px-2.5 py-1.5 rounded-md text-xs hover:bg-cos-red-tint"
                      title="Eliminar corrida">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {isExpanded ? <ChevronUp className="h-4 w-4 text-cos-ink-soft" /> : <ChevronDown className="h-4 w-4 text-cos-ink-soft" />}
                </div>
              </div>

              {/* Expanded detail table */}
              {isExpanded && (
                <div className="border-t border-cos-line">
                  {runItemsLoading ? (
                    <div className="flex items-center gap-2 text-cos-ink-soft text-xs py-6 justify-center">
                      <Loader2 className="h-4 w-4 animate-spin" /> Cargando desglose…
                    </div>
                  ) : runItemsError ? (
                    <div className="p-4">
                      <Alert tone="danger" action={<RetryButton onClick={() => loadRunDetail(run.id)} />}>
                        No se pudo cargar el desglose de la corrida.
                      </Alert>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-cos-slate-tint border-b border-cos-line">
                            <th className="text-left px-3 py-2 font-medium text-cos-ink-soft">Empleado</th>
                            <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">Sueldo</th>
                            <th className="text-right px-3 py-2 font-medium text-cos-ink-soft" title="Horas extra, bonos fijos y variables, vales y otras percepciones">Percep. extra</th>
                            <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">ISR</th>
                            <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">IMSS Obr.</th>
                            <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">IMSS Pat.</th>
                            <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">Infonavit</th>
                            {run.tipo === "AGUINALDO" && <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">Aguinaldo</th>}
                            {run.tipo === "PTU" && <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">PTU</th>}
                            <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">Percepciones</th>
                            <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">Deducciones</th>
                            <th className="text-right px-3 py-2 font-medium text-cos-ink-soft font-bold">Neto</th>
                            {run.tipo === "ORDINARIA" && (
                              <th className="text-center px-3 py-2 font-medium text-cos-ink-soft"
                                title="Faltas, horas extra, incapacidades, vacaciones, bonos y descuentos del periodo">
                                Incidencias
                              </th>
                            )}
                            <th className="text-center px-3 py-2 font-medium text-cos-ink-soft">CFDI</th>
                          </tr>
                        </thead>
                        <tbody>
                          {runItems.map(item => (
                            <tr key={item.id} className="border-b border-cos-line last:border-0 hover:bg-cos-slate-tint/50">
                              <td className="px-3 py-2">
                                <span className="font-medium">{item.employee.nombre} {item.employee.apellidoPaterno}</span>
                                <span className="text-cos-ink-soft ml-1.5 font-mono">{item.employee.rfc}</span>
                              </td>
                              <td className="px-3 py-2 text-right font-mono"><Money value={item.sueldoBase} /></td>
                              <td className="px-3 py-2 text-right font-mono"
                                title={percepExtra(item) > 0
                                  ? [
                                      item.horasExtra > 0 && `Horas extra: ${formatCurrency(item.horasExtra)}`,
                                      item.bonosPagoFijo > 0 && `Bonos fijos: ${formatCurrency(item.bonosPagoFijo)}`,
                                      item.bonosPagoVar > 0 && `Bonos variables: ${formatCurrency(item.bonosPagoVar)}`,
                                      item.vales > 0 && `Vales: ${formatCurrency(item.vales)}`,
                                      item.otrasPercepciones > 0 && `Otras: ${formatCurrency(item.otrasPercepciones)}`,
                                    ].filter(Boolean).join(" · ")
                                  : undefined}>
                                {percepExtra(item) > 0 ? formatCurrency(percepExtra(item)) : "—"}
                              </td>
                              <td className="px-3 py-2 text-right font-mono">{item.isrRetenido > 0 ? formatCurrency(item.isrRetenido) : "—"}</td>
                              <td className="px-3 py-2 text-right font-mono">{item.imssObrero > 0 ? formatCurrency(item.imssObrero) : "—"}</td>
                              <td className="px-3 py-2 text-right font-mono text-cos-ink-soft">{item.imssPatronal > 0 ? formatCurrency(item.imssPatronal) : "—"}</td>
                              <td className="px-3 py-2 text-right font-mono">{item.infonavit > 0 ? formatCurrency(item.infonavit) : "—"}</td>
                              {run.tipo === "AGUINALDO" && <td className="px-3 py-2 text-right font-mono">{item.aguinaldo > 0 ? formatCurrency(item.aguinaldo) : "—"}</td>}
                              {run.tipo === "PTU" && <td className="px-3 py-2 text-right font-mono">{item.ptu > 0 ? formatCurrency(item.ptu) : "—"}</td>}
                              <td className="px-3 py-2 text-right font-mono"><Money value={item.totalPercepciones} /></td>
                              <td className="px-3 py-2 text-right font-mono text-cos-red-ink">{formatCurrency(item.totalDeducciones)}</td>
                              <td className="px-3 py-2 text-right font-mono font-bold text-cos-jade-ink">{formatCurrency(item.netoAPagar)}</td>
                              {run.tipo === "ORDINARIA" && (
                                <td className="px-3 py-2 text-center">
                                  {(() => {
                                    const numInc = runIncidencias.filter(i => i.employeeId === item.employeeId).length;
                                    if (puedeCapturar) {
                                      return (
                                        <button onClick={() => setIncForItem(item)}
                                          className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] ${
                                            numInc > 0
                                              ? "border-cos-amber-ink/30 bg-cos-amber-tint text-cos-amber-ink hover:opacity-80"
                                              : "border-cos-line text-cos-ink-soft hover:bg-cos-paper"
                                          }`}
                                          title="Capturar incidencias del periodo — el recibo se recalcula automáticamente">
                                          <ClipboardList className="h-3 w-3" />
                                          {numInc > 0 ? numInc : "+"}
                                        </button>
                                      );
                                    }
                                    return <span className="text-cos-ink-soft">{numInc > 0 ? numInc : "—"}</span>;
                                  })()}
                                </td>
                              )}
                              <td className="px-3 py-2 text-center whitespace-nowrap">
                                {item.cfdiUuid ? (
                                  <span className="inline-flex items-center gap-1.5" title={item.cfdiUuid}>
                                    <span className="text-cos-jade-ink">✓</span>
                                    {item.invoiceId && item.pdfDisponible && (
                                      <button type="button" onClick={() => void descargarUrl(`/api/facturas/${item.invoiceId}/download?format=pdf`, "recibo.pdf")}
                                        className="text-[10px] font-medium text-cos-brand underline hover:opacity-80"
                                        title="Descargar el recibo timbrado en PDF">PDF</button>
                                    )}
                                    {item.invoiceId && item.xmlDisponible && (
                                      <button type="button" onClick={() => void descargarUrl(`/api/facturas/${item.invoiceId}/download?format=xml`, "recibo.xml")}
                                        className="text-[10px] font-medium text-cos-brand underline hover:opacity-80"
                                        title="Descargar el XML del CFDI de nómina">XML</button>
                                    )}
                                    {/* Representación impresa: imprime/guarda PDF incluso para
                                        recibos importados del SAT (se arma desde el XML). */}
                                    {item.invoiceId && (
                                      <button onClick={() => setRepInvoiceId(item.invoiceId!)}
                                        className="text-[10px] font-medium text-cos-brand underline hover:opacity-80"
                                        title="Ver la representación impresa (imprimir / guardar PDF)">Recibo</button>
                                    )}
                                    {/* Cancelable sólo si lo emitió la app (pdfDisponible ⇔ facturapiId) */}
                                    {item.invoiceId && item.pdfDisponible && (
                                      <button onClick={() => { setCancelCtx({ item, runId: run.id }); setCancelErr(""); }}
                                        className="rounded p-0.5 text-cos-red-ink/70 hover:bg-cos-red-tint hover:text-cos-red-ink"
                                        title="Cancelar este timbre ante el SAT">
                                        <Ban className="h-3 w-3" />
                                      </button>
                                    )}
                                  </span>
                                ) : run.origen !== "SAT" ? (
                                  /* Sin timbrar: vista previa BORRADOR del recibo tal
                                     como se emitiría (verifica deducciones antes de timbrar) */
                                  <button onClick={() => setPreviewItemId(item.id)}
                                    className="text-[10px] font-medium text-cos-brand underline hover:opacity-80"
                                    title="Vista previa del recibo (borrador, sin timbrar)">Vista previa</button>
                                ) : (
                                  <span className="text-cos-ink-soft">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        {runItems.length > 1 && (
                          <tfoot>
                            <tr className="bg-cos-slate-tint font-semibold">
                              <td className="px-3 py-2">Total ({runItems.length} empleados)</td>
                              <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + i.sueldoBase, 0))}</td>
                              <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + percepExtra(i), 0))}</td>
                              <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + i.isrRetenido, 0))}</td>
                              <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + i.imssObrero, 0))}</td>
                              <td className="px-3 py-2 text-right font-mono text-cos-ink-soft">{formatCurrency(runItems.reduce((s, i) => s + i.imssPatronal, 0))}</td>
                              <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + i.infonavit, 0))}</td>
                              {run.tipo === "AGUINALDO" && <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + i.aguinaldo, 0))}</td>}
                              {run.tipo === "PTU" && <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + i.ptu, 0))}</td>}
                              <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + i.totalPercepciones, 0))}</td>
                              <td className="px-3 py-2 text-right font-mono text-cos-red-ink">{formatCurrency(runItems.reduce((s, i) => s + i.totalDeducciones, 0))}</td>
                              <td className="px-3 py-2 text-right font-mono font-bold text-cos-jade-ink">{formatCurrency(runItems.reduce((s, i) => s + i.netoAPagar, 0))}</td>
                              {run.tipo === "ORDINARIA" && (
                                <td className="px-3 py-2 text-center">{runIncidencias.length > 0 ? runIncidencias.length : "—"}</td>
                              )}
                              <td className="px-3 py-2 text-center text-xs">{runItems.filter(i => i.cfdiUuid).length}/{runItems.length}</td>
                            </tr>
                          </tfoot>
                        )}
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    )}

      {/* ── Incidencias del periodo (antes pestaña propia del workspace) ── */}
      <div className="mt-8 border-t border-cos-line pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-cos-ink-soft" /> Incidencias del periodo
            </h2>
            <p className="text-xs text-cos-ink-soft mt-0.5">Faltas, incapacidades, horas extra, permisos, bonos y descuentos por mes.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-cos-ink-soft">Periodo:</label>
            <input type="month" value={incPeriodo} onChange={e => setIncPeriodo(e.target.value)}
              className="text-sm border border-cos-line rounded-md px-2 py-1.5 bg-cos-card" />
            <button onClick={() => setShowNewInc(true)} className="flex items-center gap-2 bg-cos-brand text-white px-3 py-1.5 rounded-md text-xs font-medium hover:bg-cos-brand-deep">
              <Plus className="h-3.5 w-3.5" /> Nueva incidencia
            </button>
          </div>
        </div>
      {incLoading ? (
        <div className="flex items-center gap-2 text-cos-ink-soft text-sm py-12 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" /> Cargando...
        </div>
      ) : incError ? (
        <Alert tone="danger" action={<RetryButton onClick={loadIncidencias} />}>
          No se pudieron cargar las incidencias del periodo.
        </Alert>
      ) : incidencias.length === 0 ? (
        <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-12 text-center">
          <ClipboardList className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
          <p className="font-medium text-sm">Sin incidencias en {incPeriodo}</p>
          <p className="text-xs text-cos-ink-soft mt-1">Registra faltas, incapacidades, horas extra y permisos.</p>
        </div>
      ) : (
        <div className="bg-cos-card border border-cos-line rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cos-line bg-cos-slate-tint">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Empleado</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Tipo</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Fecha</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Días</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Horas</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Monto</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Notas</th>
              </tr>
            </thead>
            <tbody>
              {incidencias.map(inc => (
                <tr key={inc.id} className="border-b border-cos-line last:border-0 hover:bg-cos-slate-tint/50">
                  <td className="px-4 py-2.5">
                    <p className="text-xs font-medium">{inc.employee.nombre} {inc.employee.apellidoPaterno}</p>
                    <p className="text-[10px] text-cos-ink-soft font-mono">{inc.employee.rfc}</p>
                  </td>
                  <td className="px-4 py-2.5 text-xs">{INCIDENCIA_LABEL[inc.tipo] ?? inc.tipo}</td>
                  <td className="px-4 py-2.5 text-xs text-cos-ink-soft">
                    {formatDate(inc.fecha)}
                    {inc.fechaFin && <> — {formatDate(inc.fechaFin)}</>}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs font-mono">{inc.dias}</td>
                  <td className="px-4 py-2.5 text-right text-xs font-mono">
                    {inc.horas || inc.horasTriples
                      ? `${inc.horas ?? 0}${inc.horasTriples ? ` + ${inc.horasTriples} triples` : ""}`
                      : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs font-mono">{inc.monto ? formatCurrency(inc.monto) : "—"}</td>
                  <td className="px-4 py-2.5 text-xs text-cos-ink-soft truncate max-w-[200px]">{inc.notas ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
      </div>

      {/* ── Confirmación de timbrado (fecha de emisión elegible) ── */}
      {stampForRun && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setStampForRun(null)}>
          <div className="bg-cos-card border border-cos-line rounded-xl shadow-xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
            <h3 className="text-sm font-bold mb-1">Timbrar corrida</h3>
            <p className="text-xs text-cos-ink-soft mb-4">
              Se emitirán CFDIs de nómina <strong>reales</strong> ante el SAT para{" "}
              {stampForRun._count?.items ?? "los"} empleado{(stampForRun._count?.items ?? 2) === 1 ? "" : "s"} ({fmtPeriodoCorto(stampForRun.periodo)}).
            </p>
            <label className="block text-xs font-medium mb-1">Fecha de emisión del CFDI</label>
            <input type="date" value={stampFecha} max={hoyStr}
              min={new Date(Date.now() - 2 * 86400000).toLocaleDateString("en-CA")}
              onChange={e => setStampFecha(e.target.value)}
              className="w-full px-3 py-2 border border-cos-line rounded-md text-sm mb-2" />
            <p className="text-[11px] text-cos-ink-soft mb-4">
              El SAT permite fechar la emisión hasta <strong>72 horas antes</strong> del timbrado. No hace falta
              antedatar para nóminas de periodos pasados: el mes fiscal lo determina la <strong>fecha de pago</strong> de
              la corrida ({formatDate(stampForRun.fechaPago)}), que viaja en el complemento como FechaPago.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setStampForRun(null)}
                className="border border-cos-line px-3 py-1.5 rounded-md text-xs hover:bg-cos-paper">Cancelar</button>
              <button onClick={() => { const r = stampForRun; setStampForRun(null); handleStamp(r.id, stampFecha); }}
                className="flex items-center gap-1.5 bg-cos-jade-ink text-white px-3 py-1.5 rounded-md text-xs font-medium hover:opacity-90">
                <Play className="h-3.5 w-3.5" /> Timbrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modals ── */}
      {showNewRun && activeCompany && (
        <NewRunModal companyId={activeCompany.id} initial={runPrefill}
          onClose={() => { setShowNewRun(false); setRunPrefill(null); }}
          onCreated={(warnings) => {
            setShowNewRun(false);
            setRunPrefill(null);
            loadRuns();
            setError(
              warnings && warnings.length > 0
                ? `✓ Corrida creada — ⚠️ ${warnings.join(" · ")}`
                : "✓ Corrida creada y calculada"
            );
          }} />
      )}
      {showAguinaldo && activeCompany && (
        <AguinaldoRunModal companyId={activeCompany.id}
          onClose={() => setShowAguinaldo(false)}
          onCreated={(warnings) => {
            setShowAguinaldo(false);
            loadRuns();
            setError(
              warnings && warnings.length > 0
                ? `✓ Corrida de aguinaldo creada — ⚠️ ${warnings.join(" · ")}`
                : "✓ Corrida de aguinaldo creada y calculada"
            );
          }} />
      )}
      {showPtu && activeCompany && (
        <PtuRunModal companyId={activeCompany.id}
          onClose={() => setShowPtu(false)}
          onCreated={(warnings) => {
            setShowPtu(false);
            loadRuns();
            setError(
              warnings && warnings.length > 0
                ? `✓ Corrida de PTU creada — ⚠️ ${warnings.join(" · ")}`
                : "✓ Corrida de PTU creada y calculada"
            );
          }} />
      )}
      {showNewInc && activeCompany && (
        <NewIncidenciaModal companyId={activeCompany.id} employees={employees}
          onClose={() => setShowNewInc(false)} onCreated={() => { setShowNewInc(false); loadIncidencias(); }} />
      )}
      {incForItem && activeCompany && expandedRunId && (
        <RunIncidenciasModal
          companyId={activeCompany.id}
          runId={expandedRunId}
          periodo={runs.find(r => r.id === expandedRunId)?.periodo ?? ""}
          item={incForItem}
          incidencias={runIncidencias.filter(i => i.employeeId === incForItem.employeeId)}
          onClose={() => setIncForItem(null)}
          onChanged={() => { loadRunDetail(expandedRunId); loadRuns(); }}
        />
      )}

      {/* representación impresa del recibo (imprimir / guardar PDF) */}
      {repInvoiceId && <RepresentacionImpresa invoiceId={repInvoiceId} onClose={() => setRepInvoiceId(null)} />}

      {/* vista previa BORRADOR de un recibo sin timbrar */}
      {previewItemId && activeCompany && (
        <RepresentacionImpresa
          previewUrl={`/api/nomina/recibos/preview?companyId=${activeCompany.id}&payrollItemId=${previewItemId}`}
          onClose={() => setPreviewItemId(null)}
        />
      )}

      {/* cancelar timbre ante el SAT */}
      {cancelCtx && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={() => !cancelBusy && setCancelCtx(null)}>
          <div className="w-full max-w-[440px] rounded-card border border-cos-line bg-cos-card p-5 shadow-card" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-[16px] font-bold text-cos-ink">Cancelar timbre ante el SAT</h3>
                <p className="mt-0.5 text-[13px] text-cos-ink-soft">
                  {cancelCtx.item.employee.nombre} {cancelCtx.item.employee.apellidoPaterno} · {formatCurrency(cancelCtx.item.netoAPagar)}
                </p>
              </div>
              <button onClick={() => !cancelBusy && setCancelCtx(null)} className="rounded p-1 text-cos-ink-faint hover:bg-cos-canvas">
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="mb-1 block text-[12.5px] font-semibold text-cos-ink">Motivo de cancelación</label>
            <select value={cancelMotivo} onChange={(e) => setCancelMotivo(e.target.value)}
              className="w-full rounded-lg border border-cos-line bg-cos-canvas px-3 py-2 text-[13.5px] text-cos-ink focus:border-cos-brand focus:outline-none">
              <option value="02">02 — Errores sin relación (cancelar y retimbrar)</option>
              <option value="01">01 — Errores con relación (ya emití el sustituto)</option>
              <option value="03">03 — No se llevó a cabo la operación</option>
              <option value="04">04 — Operación nominativa en factura global</option>
            </select>
            {cancelMotivo === "01" && (
              <input value={cancelSustituye} onChange={(e) => setCancelSustituye(e.target.value)}
                placeholder="UUID del recibo que lo sustituye"
                className="mt-2 w-full rounded-lg border border-cos-line bg-cos-canvas px-3 py-2 font-mono text-[12.5px] text-cos-ink focus:border-cos-brand focus:outline-none" />
            )}

            <p className="mt-3 rounded-lg border border-cos-amber-ink/20 bg-cos-amber-tint px-3 py-2 text-[12.5px] leading-relaxed text-cos-amber-ink">
              El CFDI se cancela ante el SAT (el receptor es el empleado — no requiere su aceptación).
              El empleado queda listo para <b>retimbrar</b>: corrige los datos, recalcula la corrida y vuelve a timbrar.
            </p>

            {cancelErr && (
              <p className="mt-2 rounded-lg border border-cos-red-ink/20 bg-cos-red-tint px-3 py-2 text-[12.5px] text-cos-red-ink">{cancelErr}</p>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setCancelCtx(null)} disabled={cancelBusy}
                className="rounded-lg border border-cos-line px-4 py-2 text-[13.5px] font-medium text-cos-ink hover:bg-cos-canvas disabled:opacity-50">
                Conservar el timbre
              </button>
              <button onClick={doCancelTimbre} disabled={cancelBusy || (cancelMotivo === "01" && !cancelSustituye.trim())}
                className="inline-flex items-center gap-1.5 rounded-lg bg-cos-red-ink px-4 py-2 text-[13.5px] font-semibold text-white hover:opacity-90 disabled:opacity-50">
                {cancelBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                {cancelBusy ? "Cancelando…" : "Cancelar ante el SAT"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
