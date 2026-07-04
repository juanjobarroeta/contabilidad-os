"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña Corridas del hub de Nómina — el workspace power-user que antes vivía
// en /nomina/detalle: lista de corridas (con las importadas del SAT en sólo
// lectura), prefill «Iniciar desde la quincena anterior», desglose por
// empleado, captura de incidencias con recálculo automático, timbrado y
// dispersión. La sección «Incidencias del periodo» (antes pestaña propia del
// workspace) vive al final, con su selector de mes. Lógica sin cambios.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Money } from "@/components/ui";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Plus, Loader2, X, AlertCircle, CheckCircle2, Play, Calendar, ClipboardList,
  ArrowLeftRight, ChevronDown, ChevronUp, Trash2, History, RefreshCw,
} from "lucide-react";
import {
  TIPO_RUN_LABEL, STATUS_RUN_LABEL, STATUS_RUN_COLOR,
  INCIDENCIA_LABEL,
  percepExtra,
  type Employee, type PayrollRun, type PayrollItemDetail,
  type RunPrefill, type Incidencia, type RunIncidencia,
} from "./workspace-shared";
import { NewRunModal, NewIncidenciaModal, RunIncidenciasModal } from "./RunModals";

export default function CorridasTab() {
  const { activeCompany } = useCompany();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [error, setError] = useState("");

  // Corridas state
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [showNewRun, setShowNewRun] = useState(false);
  const [runPrefill, setRunPrefill] = useState<RunPrefill | null>(null);
  const [prefillLoading, setPrefillLoading] = useState(false);
  const [stampingId, setStampingId] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runItems, setRunItems] = useState<PayrollItemDetail[]>([]);
  const [runItemsLoading, setRunItemsLoading] = useState(false);
  // Incidencias del periodo de la corrida expandida + item con el modal abierto.
  const [runIncidencias, setRunIncidencias] = useState<RunIncidencia[]>([]);
  const [incForItem, setIncForItem] = useState<PayrollItemDetail | null>(null);

  // Incidencias state (sección «Incidencias del periodo»)
  const [incidencias, setIncidencias] = useState<Incidencia[]>([]);
  const [incLoading, setIncLoading] = useState(false);
  const [showNewInc, setShowNewInc] = useState(false);
  const now = new Date();
  const [incPeriodo, setIncPeriodo] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);

  const loadEmployees = useCallback(async () => {
    if (!activeCompany) return;
    try {
      const res = await fetch(`/api/empleados?companyId=${activeCompany.id}`);
      const data = await res.json();
      setEmployees(Array.isArray(data) ? data : []);
    } catch { /* silent */ }
  }, [activeCompany]);

  const loadRuns = useCallback(async () => {
    if (!activeCompany) return;
    setRunsLoading(true);
    try {
      const res = await fetch(`/api/nomina/run?companyId=${activeCompany.id}`);
      const data = await res.json();
      setRuns(Array.isArray(data) ? data : []);
    } catch { /* silent */ }
    finally { setRunsLoading(false); }
  }, [activeCompany]);

  const loadIncidencias = useCallback(async () => {
    if (!activeCompany) return;
    setIncLoading(true);
    try {
      const res = await fetch(`/api/nomina/incidencias?companyId=${activeCompany.id}&periodo=${incPeriodo}`);
      const data = await res.json();
      setIncidencias(data.incidencias ?? []);
    } catch { /* silent */ }
    finally { setIncLoading(false); }
  }, [activeCompany, incPeriodo]);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);
  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => { loadIncidencias(); }, [loadIncidencias]);

  const loadRunDetail = useCallback(async (runId: string) => {
    setRunItemsLoading(true);
    try {
      const res = await fetch(`/api/nomina/run/${runId}`);
      const data = await res.json();
      setRunItems(data.items ?? []);
      setRunIncidencias(data.incidencias ?? []);
    } catch { setRunItems([]); setRunIncidencias([]); }
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

  async function handleStamp(runId: string) {
    setStampingId(runId);
    setError("");
    try {
      const res = await fetch(`/api/nomina/run/${runId}/stamp`, { method: "POST" });
      const data = await res.json();
      if (data.errors?.length) {
        setError(`Timbrado: ${data.stamped}/${data.total} OK. Errores: ${data.errors.join("; ")}`);
      } else {
        setError(`✓ ${data.stamped} recibos timbrados exitosamente`);
      }
      loadRuns();
    } catch { setError("Error al timbrar"); }
    finally { setStampingId(null); }
  }

  if (!activeCompany) {
    return <div className="p-8 text-cos-ink-soft text-sm">Selecciona una empresa para ver su nómina.</div>;
  }

  return (
    <div className="p-6 max-w-5xl">
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

    {runsLoading ? (
      <div className="flex items-center gap-2 text-cos-ink-soft text-sm py-12 justify-center">
        <Loader2 className="h-5 w-5 animate-spin" /> Cargando corridas...
      </div>
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
              {/* Run header — clickable to expand */}
              <div className="p-4 flex items-center gap-4 cursor-pointer hover:bg-cos-slate-tint/50" onClick={() => toggleRunDetail(run.id)}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
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
                  <p className="text-xs text-cos-ink-soft">{run.periodo}</p>
                  <div className="flex gap-4 mt-1 text-xs">
                    <span>Empleados: <strong>{run._count?.items ?? "—"}</strong></span>
                    <span>Percepciones: <strong><Money value={run.totalPercepciones} /></strong></span>
                    <span>Deducciones: <strong><Money value={run.totalDeducciones} /></strong></span>
                    <span>Neto: <strong className="text-cos-jade-ink">{formatCurrency(run.totalNeto)}</strong></span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                  {puedeCapturar && (
                    <button onClick={() => handleRecalc(run.id)} disabled={recalcId === run.id}
                      className="flex items-center gap-1.5 border border-cos-line px-3 py-1.5 rounded-md text-xs hover:bg-cos-paper disabled:opacity-50"
                      title="Recalcular todos los recibos con las incidencias vigentes del periodo">
                      {recalcId === run.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      Recalcular
                    </button>
                  )}
                  {run.status === "CALCULATED" && (
                    <button onClick={() => handleStamp(run.id)} disabled={stampingId === run.id}
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
                              <td className="px-3 py-2 text-center">
                                {item.cfdiUuid ? (
                                  <span className="text-cos-jade-ink" title={item.cfdiUuid}>✓</span>
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
          <div className="flex items-center gap-2">
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
      ) : incidencias.length === 0 ? (
        <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-12 text-center">
          <ClipboardList className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
          <p className="font-medium text-sm">Sin incidencias en {incPeriodo}</p>
          <p className="text-xs text-cos-ink-soft mt-1">Registra faltas, incapacidades, horas extra y permisos.</p>
        </div>
      ) : (
        <div className="bg-cos-card border border-cos-line rounded-xl overflow-hidden">
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
      )}
      </div>

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
    </div>
  );
}
