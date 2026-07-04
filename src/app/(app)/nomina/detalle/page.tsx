"use client";

import { useCallback, useEffect, useState } from "react";
import { Money } from "@/components/ui";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Plus, Users2, Loader2, X, AlertCircle, CheckCircle2, Receipt,
  Upload, Sparkles, FileText, Play, Download, Calendar, ClipboardList,
  ArrowLeftRight, Shield, ChevronDown, ChevronUp, UserX, Trash2,
  Wand2, History, RefreshCw,
} from "lucide-react";
import { RosterImport } from "./RosterImport";

interface PayrollItemDetail {
  id: string;
  employeeId: string;
  sueldoBase: number;
  horasExtra: number;
  bonosPagoFijo: number;
  bonosPagoVar: number;
  vales: number;
  otrasPercepciones: number;
  isrRetenido: number;
  imssObrero: number;
  imssPatronal: number;
  infonavit: number;
  otrasDeducc: number;
  aguinaldo: number;
  primaVacacional: number;
  vacaciones: number;
  ptu: number;
  totalPercepciones: number;
  totalDeducciones: number;
  netoAPagar: number;
  cfdiUuid: string | null;
  employee: { nombre: string; apellidoPaterno: string; rfc: string };
}

// Suma de percepciones extra (sobre el sueldo base): horas extra, bonos fijos y
// variables, vales y otras. Es lo que convierte "ver un nombre" en "ver la nómina".
function percepExtra(i: PayrollItemDetail): number {
  return i.horasExtra + i.bonosPagoFijo + i.bonosPagoVar + i.vales + i.otrasPercepciones;
}

// ── PayrollRun types ─────────────────────────────────────────────────────────
interface PayrollRun {
  id: string;
  periodo: string;
  fechaPago: string;
  tipo: string;
  status: string;
  totalPercepciones: number;
  totalDeducciones: number;
  totalNeto: number;
  extraData: Record<string, unknown> | null;
  /** "APP" = creada en la app; "SAT" = importada del histórico timbrado (sólo lectura). */
  origen?: string;
  createdAt: string;
  _count?: { items: number };
}

/** Respuesta de GET /api/nomina/run/prefill — insumos de la siguiente corrida. */
interface RunPrefill {
  basadoEnRunId: string;
  basadoEnPeriodo: string;
  tipo: string;
  periodicidad: string;
  periodoInicio: string;
  periodoFin: string;
  fechaPago: string;
  diasPagados: number;
  employeeIds: string[];
  omitidosPorBaja: number;
}

interface Incidencia {
  id: string;
  tipo: string;
  fecha: string;
  fechaFin: string | null;
  dias: number;
  horas: number | null;
  horasTriples: number | null;
  monto: number | null;
  notas: string | null;
  periodo: string | null;
  employee: { nombre: string; apellidoPaterno: string; rfc: string };
}

/** Incidencia del periodo de una corrida (GET /api/nomina/run/[id]) — sin
 *  include de empleado: se cruza con los items por employeeId. */
interface RunIncidencia {
  id: string;
  employeeId: string;
  tipo: string;
  fecha: string;
  fechaFin: string | null;
  dias: number;
  horas: number | null;
  horasTriples: number | null;
  monto: number | null;
  ramoImss: string | null;
  notas: string | null;
}

const TIPO_RUN_LABEL: Record<string, string> = {
  ORDINARIA: "Ordinaria",
  EXTRAORDINARIA: "Extraordinaria",
  FINIQUITO: "Finiquito",
  AGUINALDO: "Aguinaldo",
  VACACIONES: "Vacaciones",
  PTU: "PTU",
};

const STATUS_RUN_LABEL: Record<string, string> = {
  DRAFT: "Borrador",
  CALCULATED: "Calculada",
  STAMPED: "Timbrada",
  PAID: "Pagada",
};

const STATUS_RUN_COLOR: Record<string, string> = {
  DRAFT: "bg-cos-slate-tint text-cos-ink-soft",
  CALCULATED: "bg-cos-brand-tint text-cos-brand-ink",
  STAMPED: "bg-cos-jade-tint text-cos-jade-ink",
  PAID: "bg-cos-jade-tint text-cos-jade-ink",
};

const INCIDENCIA_LABEL: Record<string, string> = {
  FALTA: "Falta",
  FALTA_JUSTIFICADA: "Falta justificada",
  INCAPACIDAD: "Incapacidad",
  PERMISO_CON_GOCE: "Permiso c/ goce",
  PERMISO_SIN_GOCE: "Permiso s/ goce",
  HORAS_EXTRA: "Horas extra",
  VACACIONES: "Vacaciones",
  RETARDO: "Retardo",
  BONO: "Bono / Destajo",
  COMISION: "Comisión",
  DESCUENTO: "Descuento",
};

// Tipos que requieren monto en pesos (percepciones/deducciones del periodo).
const INCIDENCIA_CON_MONTO = ["BONO", "COMISION", "DESCUENTO"];
// Tipos que se capturan en días.
const INCIDENCIA_CON_DIAS = [
  "FALTA", "FALTA_JUSTIFICADA", "INCAPACIDAD", "PERMISO_CON_GOCE", "PERMISO_SIN_GOCE", "VACACIONES",
];

const RAMO_IMSS_LABEL: Record<string, string> = {
  "01": "Riesgo de trabajo",
  "02": "Enfermedad general",
  "03": "Maternidad",
};

type TabId = "empleados" | "corridas" | "incidencias";

interface Employee {
  id: string;
  nombre: string;
  apellidoPaterno: string;
  apellidoMaterno: string | null;
  rfc: string;
  curp: string;
  nss: string;
  salarioDiario: number;
  salarioDiarioIntegrado: number | null;
  periodicidadPago: string;
  fechaIngreso: string;
  puesto: string | null;
  departamento: string | null;
  clabe: string | null;
  banco: string | null;
  isActive: boolean;
}

// Bancos comunes en México para dispersión SPEI (consistente con el módulo de Bancos).
const BANCOS = ["BBVA", "Banamex", "Santander", "Banorte", "HSBC", "Scotiabank", "Afirme", "Inbursa", "BanBajío", "Otro"];

const PERIODICIDAD_LABEL: Record<string, string> = {
  "01": "Diario",
  "02": "Semanal",
  "03": "Catorcenal",
  "04": "Quincenal",
  "05": "Mensual",
  "06": "Bimestral",
  "10": "Decenal",
  "99": "Otro",
};

export default function NominaPage() {
  const { activeCompany } = useCompany();
  const [tab, setTab] = useState<TabId>("empleados");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [emitFor, setEmitFor] = useState<Employee | null>(null);
  const [editFor, setEditFor] = useState<Employee | null>(null);
  const [bajaFor, setBajaFor] = useState<Employee | null>(null);
  const [showImport, setShowImport] = useState(false);

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

  // Incidencias state
  const [incidencias, setIncidencias] = useState<Incidencia[]>([]);
  const [incLoading, setIncLoading] = useState(false);
  const [showNewInc, setShowNewInc] = useState(false);
  const now = new Date();
  const [incPeriodo, setIncPeriodo] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);

  const loadEmployees = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/empleados?companyId=${activeCompany.id}`);
      const data = await res.json();
      setEmployees(Array.isArray(data) ? data : []);
    } catch { setError("Error al cargar empleados"); }
    finally { setLoading(false); }
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
  useEffect(() => { if (tab === "corridas") loadRuns(); }, [tab, loadRuns]);
  useEffect(() => { if (tab === "incidencias") loadIncidencias(); }, [tab, loadIncidencias, incPeriodo]);

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
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Nómina</h1>
          <p className="text-sm text-cos-ink-soft mt-0.5">{activeCompany.razonSocial}</p>
        </div>
        <div className="flex items-center gap-2">
          {tab === "empleados" && (
            <>
              <button onClick={() => setShowImport(true)} className="flex items-center gap-2 border border-cos-line px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-paper" title="Reconstruir el equipo desde tus recibos de nómina">
                <Wand2 className="h-4 w-4" /> Importar desde recibos
              </button>
              <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep">
                <Plus className="h-4 w-4" /> Nuevo empleado
              </button>
            </>
          )}
          {tab === "corridas" && (
            <>
              <button onClick={handlePrefillRun} disabled={prefillLoading}
                className="flex items-center gap-2 border border-cos-line px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-paper disabled:opacity-50"
                title="Prellena la siguiente corrida con los empleados y el periodo que sigue a la corrida ordinaria más reciente">
                {prefillLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />}
                Iniciar desde la quincena anterior
              </button>
              <button onClick={() => { setRunPrefill(null); setShowNewRun(true); }} className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep">
                <Plus className="h-4 w-4" /> Nueva corrida
              </button>
              <a href={`/api/nomina/sua-export?companyId=${activeCompany.id}&bimestre=${Math.ceil((now.getMonth() + 1) / 2)}&year=${now.getFullYear()}`}
                className="flex items-center gap-1.5 border border-cos-line px-3 py-2 rounded-md text-xs hover:bg-cos-paper" title="Exportar SUA">
                <Download className="h-3.5 w-3.5" /> SUA
              </a>
              <a href={`/api/nomina/imss-movimientos?companyId=${activeCompany.id}&format=idse&status=PENDING`}
                className="flex items-center gap-1.5 border border-cos-line px-3 py-2 rounded-md text-xs hover:bg-cos-paper" title="Exportar IDSE">
                <Shield className="h-3.5 w-3.5" /> IDSE
              </a>
            </>
          )}
          {tab === "incidencias" && (
            <button onClick={() => setShowNewInc(true)} className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep">
              <Plus className="h-4 w-4" /> Nueva incidencia
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-cos-line mb-5">
        <div className="flex gap-1">
          {([
            ["empleados", "Empleados", Users2],
            ["corridas", "Corridas de nómina", Calendar],
            ["incidencias", "Incidencias", ClipboardList],
          ] as const).map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTab(id as TabId)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === id ? "border-cos-brand text-cos-brand-ink" : "border-transparent text-cos-ink-soft hover:text-cos-ink"
              }`}>
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
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

      {/* ── Empleados Tab ── */}
      {tab === "empleados" && (
        <>
          {loading ? (
            <div className="flex items-center gap-2 text-cos-ink-soft text-sm py-12 justify-center">
              <Loader2 className="h-5 w-5 animate-spin" /> Cargando empleados...
            </div>
          ) : employees.length === 0 ? (
            <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-12 text-center">
              <Users2 className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
              <p className="font-medium text-sm">Sin empleados</p>
              <p className="text-xs text-cos-ink-soft mt-1">Reconstruye tu equipo desde los recibos de nómina que ya timbraste, o agrégalo manualmente.</p>
              <div className="mt-4 flex items-center justify-center gap-2">
                <button onClick={() => setShowImport(true)} className="inline-flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep">
                  <Wand2 className="h-4 w-4" /> Importar desde recibos de nómina
                </button>
                <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-2 border border-cos-line px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-paper">
                  <Plus className="h-4 w-4" /> Nuevo empleado
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-cos-card border border-cos-line rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-cos-line bg-cos-slate-tint">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Empleado</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Puesto</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">SBC / día</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Periodicidad</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Ingreso</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map(e => (
                    <tr key={e.id} className="border-b border-cos-line last:border-0 hover:bg-cos-slate-tint/50">
                      <td className="px-4 py-3">
                        <button onClick={() => setEditFor(e)} className="text-left hover:text-cos-brand-ink transition-colors">
                          <p className="font-medium">{e.nombre} {e.apellidoPaterno} {e.apellidoMaterno ?? ""}</p>
                          <p className="text-xs text-cos-ink-soft font-mono">{e.rfc}</p>
                        </button>
                      </td>
                      <td className="px-4 py-3 text-xs">{e.puesto ?? "—"}{e.departamento && <p className="text-cos-ink-soft">{e.departamento}</p>}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs"><Money value={e.salarioDiario} /></td>
                      <td className="px-4 py-3 text-xs">{PERIODICIDAD_LABEL[e.periodicidadPago] ?? e.periodicidadPago}</td>
                      <td className="px-4 py-3 text-xs text-cos-ink-soft">{formatDate(e.fechaIngreso)}</td>
                      <td className="px-4 py-3 text-right space-x-1.5">
                        <button onClick={() => setEmitFor(e)} className="text-xs bg-cos-brand text-white px-3 py-1.5 rounded-md hover:bg-cos-brand-deep inline-flex items-center gap-1.5">
                          <Receipt className="h-3.5 w-3.5" /> Emitir recibo
                        </button>
                        <button onClick={() => setBajaFor(e)} className="text-xs border border-cos-red-ink/20 text-cos-red-ink px-2.5 py-1.5 rounded-md hover:bg-cos-red-tint inline-flex items-center gap-1"
                          title="Dar de baja">
                          <UserX className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ── Corridas Tab ── */}
      {tab === "corridas" && (
        <>
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
        </>
      )}

      {/* ── Incidencias Tab ── */}
      {tab === "incidencias" && (
        <>
          <div className="flex items-center gap-2 mb-4">
            <label className="text-xs text-cos-ink-soft">Periodo:</label>
            <input type="month" value={incPeriodo} onChange={e => setIncPeriodo(e.target.value)}
              className="text-sm border border-cos-line rounded-md px-2 py-1.5 bg-cos-card" />
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
        </>
      )}

      {/* ── Modals ── */}
      {showImport && activeCompany && (
        <RosterImport
          companyId={activeCompany.id}
          onClose={() => setShowImport(false)}
          onImported={(creados) => {
            setShowImport(false);
            loadEmployees();
            setError(`✓ Se importaron ${creados} empleado${creados === 1 ? "" : "s"} desde tus recibos de nómina.`);
          }}
        />
      )}
      {showAdd && activeCompany && (
        <NewEmployeeModal companyId={activeCompany.id} onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); loadEmployees(); }} />
      )}
      {emitFor && activeCompany && (
        <EmitNominaModal companyId={activeCompany.id} employee={emitFor}
          onClose={() => setEmitFor(null)} onEmitted={(msg) => { setEmitFor(null); setError(`✓ ${msg}`); }} />
      )}
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
      {editFor && activeCompany && (
        <EditEmployeeModal companyId={activeCompany.id} employee={editFor}
          onClose={() => setEditFor(null)} onSaved={() => { setEditFor(null); loadEmployees(); setError("✓ Empleado actualizado"); }} />
      )}
      {bajaFor && activeCompany && (
        <BajaModal companyId={activeCompany.id} employee={bajaFor}
          onClose={() => setBajaFor(null)} onDone={(msg) => { setBajaFor(null); loadEmployees(); setError(`✓ ${msg}`); }} />
      )}
    </div>
  );
}

// ── New Employee modal ───────────────────────────────────────────────────────
function NewEmployeeModal({
  companyId, onClose, onCreated,
}: {
  companyId: string; onClose: () => void; onCreated: () => void;
}) {
  const [form, setForm] = useState({
    nombre: "", apellidoPaterno: "", apellidoMaterno: "",
    rfc: "", curp: "", nss: "",
    fechaIngreso: new Date().toISOString().slice(0, 10),
    salarioDiario: "",
    periodicidadPago: "04",
    puesto: "",
    departamento: "",
    riesgoPuesto: "1",
    claveEntFed: "PUE",
    creditoInfonavit: "",
    tipoDescuentoInfonavit: "",
    descuentoInfonavit: "",
    clabe: "",
    banco: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [aiParsing, setAiParsing] = useState(false);
  const [aiDocs, setAiDocs] = useState<{ name: string; type: string }[]>([]);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm(p => ({ ...p, [k]: v }));
  }

  async function handleAiUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setAiParsing(true);
    setErr("");
    setAiWarnings([]);
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/nomina/parse-employee-docs", {
          method: "POST", body: fd,
        });
        const data = await res.json();
        if (!res.ok) { setErr(`${file.name}: ${data.error ?? "Error"}`); continue; }

        setAiDocs(prev => [...prev, { name: file.name, type: data.type }]);
        if (data.warnings?.length) setAiWarnings(prev => [...prev, ...data.warnings]);

        // Merge extracted fields (non-empty override existing)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e: any = data.employee ?? {};
        setForm(prev => ({
          nombre: e.nombre?.trim() || prev.nombre,
          apellidoPaterno: e.apellidoPaterno?.trim() || prev.apellidoPaterno,
          apellidoMaterno: e.apellidoMaterno?.trim() || prev.apellidoMaterno,
          rfc: e.rfc?.trim().toUpperCase() || prev.rfc,
          curp: e.curp?.trim().toUpperCase() || prev.curp,
          nss: String(e.nss ?? "").trim() || prev.nss,
          fechaIngreso: e.fechaIngreso || e.fechaAlta || prev.fechaIngreso,
          salarioDiario: e.salarioDiario ? String(e.salarioDiario) : (e.salarioMensual ? String(Math.round((e.salarioMensual / 30.4) * 100) / 100) : (e.salarioBaseCotizacion && !e.salarioDiario ? "" : prev.salarioDiario)),
          periodicidadPago: e.periodicidadPago || prev.periodicidadPago,
          puesto: e.puesto?.trim() || prev.puesto,
          departamento: e.departamento?.trim() || prev.departamento,
          riesgoPuesto: prev.riesgoPuesto,
          claveEntFed: e.claveEntFed || prev.claveEntFed,
          creditoInfonavit: e.creditoInfonavit?.trim() || prev.creditoInfonavit,
          tipoDescuentoInfonavit: e.tipoDescuentoInfonavit || prev.tipoDescuentoInfonavit,
          descuentoInfonavit: e.descuentoInfonavit ? String(e.descuentoInfonavit) : prev.descuentoInfonavit,
          clabe: e.clabe?.trim() || prev.clabe,
          banco: e.banco?.trim() || prev.banco,
        }));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setAiParsing(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/empleados", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          ...form,
          rfc: form.rfc.toUpperCase(),
          curp: form.curp.toUpperCase(),
          salarioDiario: parseFloat(form.salarioDiario),
          creditoInfonavit: form.creditoInfonavit || undefined,
          tipoDescuentoInfonavit: form.tipoDescuentoInfonavit || undefined,
          descuentoInfonavit: form.descuentoInfonavit ? parseFloat(form.descuentoInfonavit) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error");
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center pt-12 p-4 z-50 overflow-auto">
      <div className="bg-cos-card rounded-xl shadow-xl w-full max-w-lg">
        <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
          <h2 className="font-semibold">Nuevo empleado</h2>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-3">
          {/* AI Upload Zone */}
          <div className="bg-cos-brand-tint/60 border border-cos-brand-ink/15 rounded-lg p-3">
            <label className="flex items-center gap-3 px-3 py-2.5 border-2 border-dashed border-cos-brand-ink/15 rounded-md text-sm bg-cos-card cursor-pointer hover:bg-cos-brand-tint/50 transition-colors">
              {aiParsing ? (
                <Loader2 className="h-4 w-4 text-cos-brand-ink shrink-0 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4 text-cos-brand-ink shrink-0" />
              )}
              <span className="text-cos-ink-soft truncate flex-1 text-xs">
                {aiParsing ? "Leyendo documentos…" : "Sube CURP, NSS, contrato, INE — llena automáticamente"}
              </span>
              <input
                type="file"
                accept="application/pdf,.pdf,image/*"
                multiple
                disabled={aiParsing}
                className="hidden"
                onChange={(e) => { handleAiUpload(e.target.files); e.target.value = ""; }}
              />
            </label>
            {aiDocs.length > 0 && (
              <div className="mt-2 space-y-1">
                {aiDocs.map((d, i) => (
                  <div key={i} className="flex items-center gap-2 text-[10px] text-cos-brand-ink">
                    <FileText className="h-3 w-3" />
                    <span className="truncate">{d.name}</span>
                    <span className="text-cos-brand-ink font-medium">{d.type}</span>
                  </div>
                ))}
              </div>
            )}
            {aiWarnings.length > 0 && (
              <div className="mt-2 space-y-0.5">
                {aiWarnings.map((w, i) => (
                  <p key={i} className="text-[10px] text-cos-amber-ink">⚠ {w}</p>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="Nombre(s)*"><input required value={form.nombre} onChange={e => set("nombre", e.target.value)} className={inputCls} /></Field>
            <Field label="Apellido paterno*"><input required value={form.apellidoPaterno} onChange={e => set("apellidoPaterno", e.target.value)} className={inputCls} /></Field>
            <Field label="Apellido materno"><input value={form.apellidoMaterno} onChange={e => set("apellidoMaterno", e.target.value)} className={inputCls} /></Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="RFC*"><input required value={form.rfc} onChange={e => set("rfc", e.target.value)} className={inputCls} placeholder="13 caracteres" /></Field>
            <Field label="CURP*"><input required value={form.curp} onChange={e => set("curp", e.target.value)} className={inputCls} placeholder="18 caracteres" /></Field>
            <Field label="NSS*"><input required value={form.nss} onChange={e => set("nss", e.target.value)} className={inputCls} placeholder="11 dígitos" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fecha de ingreso*">
              <input required type="date" value={form.fechaIngreso} onChange={e => set("fechaIngreso", e.target.value)} className={inputCls} />
            </Field>
            <Field label="Salario diario (SBC)*">
              <input required type="number" min="0" step="0.01" value={form.salarioDiario} onChange={e => set("salarioDiario", e.target.value)} className={inputCls} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Periodicidad de pago">
              <select value={form.periodicidadPago} onChange={e => set("periodicidadPago", e.target.value)} className={inputCls}>
                <option value="01">Diario</option>
                <option value="02">Semanal</option>
                <option value="03">Catorcenal</option>
                <option value="04">Quincenal</option>
                <option value="05">Mensual</option>
              </select>
            </Field>
            <Field label="Riesgo de puesto">
              <select value={form.riesgoPuesto} onChange={e => set("riesgoPuesto", e.target.value)} className={inputCls}>
                <option value="1">Clase I</option>
                <option value="2">Clase II</option>
                <option value="3">Clase III</option>
                <option value="4">Clase IV</option>
                <option value="5">Clase V</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Puesto"><input value={form.puesto} onChange={e => set("puesto", e.target.value)} className={inputCls} /></Field>
            <Field label="Departamento"><input value={form.departamento} onChange={e => set("departamento", e.target.value)} className={inputCls} /></Field>
          </div>

          {/* Datos bancarios (dispersión SPEI) */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="CLABE interbancaria">
              <input value={form.clabe} onChange={e => set("clabe", e.target.value.replace(/\D/g, "").slice(0, 18))}
                className={inputCls} inputMode="numeric" placeholder="18 dígitos" maxLength={18} />
            </Field>
            <Field label="Banco">
              <select value={form.banco} onChange={e => set("banco", e.target.value)} className={inputCls}>
                <option value="">Sin especificar</option>
                {BANCOS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
          </div>

          {/* Infonavit section */}
          <details className="border border-cos-line rounded-lg">
            <summary className="px-3 py-2 text-xs font-medium cursor-pointer hover:bg-cos-slate-tint flex items-center gap-2">
              <span>Infonavit</span>
              {form.descuentoInfonavit && (
                <span className="text-[10px] bg-cos-jade-tint text-cos-jade-ink px-1.5 py-0.5 rounded-full font-medium">
                  ${form.descuentoInfonavit}
                </span>
              )}
            </summary>
            <div className="px-3 pb-3 pt-1 space-y-2 border-t border-cos-line">
              <div className="grid grid-cols-3 gap-2">
                <Field label="N° crédito">
                  <input value={form.creditoInfonavit} onChange={e => set("creditoInfonavit", e.target.value)} className={inputCls} placeholder="Opcional" />
                </Field>
                <Field label="Tipo descuento">
                  <select value={form.tipoDescuentoInfonavit} onChange={e => set("tipoDescuentoInfonavit", e.target.value)} className={inputCls}>
                    <option value="">Sin crédito</option>
                    <option value="PESOS">Cuota fija ($)</option>
                    <option value="PCT_SBC">% del SBC</option>
                    <option value="VSM">VSM (veces UMA)</option>
                  </select>
                </Field>
                <Field label={form.tipoDescuentoInfonavit === "PCT_SBC" ? "Porcentaje" : form.tipoDescuentoInfonavit === "VSM" ? "Veces UMA" : "Monto"}>
                  <input type="number" min="0" step="0.01" value={form.descuentoInfonavit}
                    onChange={e => set("descuentoInfonavit", e.target.value)} className={inputCls}
                    placeholder={form.tipoDescuentoInfonavit === "PCT_SBC" ? "Ej: 0.20" : form.tipoDescuentoInfonavit === "VSM" ? "Ej: 3.5" : "Ej: 1321.50"} />
                </Field>
              </div>
            </div>
          </details>

          {err && <p className="text-xs text-cos-red-ink">{err}</p>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 border border-cos-line rounded-md py-2 text-sm">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 bg-cos-brand text-white rounded-md py-2 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Guardar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Emit Nomina modal ────────────────────────────────────────────────────────
function EmitNominaModal({
  companyId, employee, onClose, onEmitted,
}: {
  companyId: string;
  employee: Employee;
  onClose: () => void;
  onEmitted: (msg: string) => void;
}) {
  // Default to current quincena
  const today = new Date();
  const day = today.getUTCDate();
  const isFirstHalf = day <= 15;
  const periodoInicio = isFirstHalf
    ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))
    : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 16));
  const periodoFin = isFirstHalf
    ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 15))
    : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));

  const [form, setForm] = useState({
    periodoInicio: periodoInicio.toISOString().slice(0, 10),
    periodoFin: periodoFin.toISOString().slice(0, 10),
    diasPagados: "15",
    fechaPago: today.toISOString().slice(0, 10),
    sueldoBruto: (employee.salarioDiario * 15).toFixed(2),
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm(p => ({ ...p, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/nomina/emit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          employeeId: employee.id,
          periodoInicio: form.periodoInicio,
          periodoFin: form.periodoFin,
          diasPagados: parseInt(form.diasPagados),
          fechaPago: form.fechaPago,
          sueldoBruto: parseFloat(form.sueldoBruto),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al timbrar");
      onEmitted(`Recibo emitido. Neto: ${formatCurrency(data.netoAPagar)}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center pt-16 p-4 z-50">
      <div className="bg-cos-card rounded-xl shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Emitir recibo de nómina</h2>
            <p className="text-xs text-cos-ink-soft mt-0.5">
              {employee.nombre} {employee.apellidoPaterno}
            </p>
          </div>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Periodo inicio">
              <input type="date" value={form.periodoInicio} onChange={e => set("periodoInicio", e.target.value)} className={inputCls} />
            </Field>
            <Field label="Periodo fin">
              <input type="date" value={form.periodoFin} onChange={e => set("periodoFin", e.target.value)} className={inputCls} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Días pagados">
              <input type="number" min="1" max="31" value={form.diasPagados} onChange={e => set("diasPagados", e.target.value)} className={inputCls} />
            </Field>
            <Field label="Fecha de pago">
              <input type="date" value={form.fechaPago} onChange={e => set("fechaPago", e.target.value)} className={inputCls} />
            </Field>
          </div>
          <Field label="Sueldo bruto del periodo">
            <input type="number" min="0" step="0.01" value={form.sueldoBruto} onChange={e => set("sueldoBruto", e.target.value)} className={inputCls} />
          </Field>
          <div className="bg-cos-brand-tint border border-cos-brand-ink/15 rounded-md p-3 text-xs text-cos-brand-ink">
            <p className="font-medium mb-1">Cómo se calcula</p>
            <p>ISR: tarifa Art. 96 LISR + subsidio al empleo. IMSS: cuotas reales escalonadas (EyM, IyV, retiro, cesantía, guarderías) según clase de riesgo. Infonavit se deduce si el empleado tiene crédito activo. Exporta a SUA desde la pestaña Corridas.</p>
          </div>
          {err && <p className="text-xs text-cos-red-ink">{err}</p>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 border border-cos-line rounded-md py-2 text-sm">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 bg-cos-brand text-white rounded-md py-2 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Timbrar nómina
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Edit Employee Modal ────────────────────────────────────────────────────
function EditEmployeeModal({
  companyId, employee, onClose, onSaved,
}: { companyId: string; employee: Employee; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    nombre: employee.nombre,
    apellidoPaterno: employee.apellidoPaterno,
    apellidoMaterno: employee.apellidoMaterno ?? "",
    salarioDiario: String(employee.salarioDiario),
    periodicidadPago: employee.periodicidadPago,
    puesto: employee.puesto ?? "",
    departamento: employee.departamento ?? "",
    creditoInfonavit: "",
    tipoDescuentoInfonavit: "",
    descuentoInfonavit: "",
    clabe: employee.clabe ?? "",
    banco: employee.banco ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [skipImss, setSkipImss] = useState(true); // default: corrections don't generate IMSS

  // Load full employee data (including Infonavit) on mount
  useEffect(() => {
    fetch(`/api/empleados?companyId=${companyId}`)
      .then(r => r.json())
      .then((emps: Employee[]) => {
        // The list endpoint may not return Infonavit fields, but we set what we have
      });
  }, [companyId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/empleados", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          employeeId: employee.id,
          nombre: form.nombre,
          apellidoPaterno: form.apellidoPaterno,
          apellidoMaterno: form.apellidoMaterno || null,
          salarioDiario: parseFloat(form.salarioDiario),
          periodicidadPago: form.periodicidadPago,
          puesto: form.puesto || null,
          departamento: form.departamento || null,
          creditoInfonavit: form.creditoInfonavit || null,
          tipoDescuentoInfonavit: form.tipoDescuentoInfonavit || null,
          descuentoInfonavit: form.descuentoInfonavit ? parseFloat(form.descuentoInfonavit) : null,
          clabe: form.clabe || null,
          banco: form.banco || null,
          skipImssMovimiento: skipImss,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error");
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center pt-12 p-4 z-50 overflow-auto">
      <div className="bg-cos-card rounded-xl shadow-xl w-full max-w-lg">
        <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Editar empleado</h2>
            <p className="text-xs text-cos-ink-soft font-mono">{employee.rfc} · NSS {employee.nss}</p>
          </div>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Nombre(s)"><input required value={form.nombre} onChange={e => setForm(p => ({ ...p, nombre: e.target.value }))} className={inputCls} /></Field>
            <Field label="Ap. Paterno"><input required value={form.apellidoPaterno} onChange={e => setForm(p => ({ ...p, apellidoPaterno: e.target.value }))} className={inputCls} /></Field>
            <Field label="Ap. Materno"><input value={form.apellidoMaterno} onChange={e => setForm(p => ({ ...p, apellidoMaterno: e.target.value }))} className={inputCls} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Salario diario (SBC)">
              <input required type="number" min="0" step="0.01" value={form.salarioDiario}
                onChange={e => setForm(p => ({ ...p, salarioDiario: e.target.value }))} className={inputCls} />
              {parseFloat(form.salarioDiario) !== employee.salarioDiario && (
                <label className="flex items-start gap-2 mt-1.5 text-[10px] text-cos-amber-ink bg-cos-amber-tint border border-cos-amber-ink/20 rounded px-2 py-1.5 cursor-pointer">
                  <input type="checkbox" checked={skipImss} onChange={e => setSkipImss(e.target.checked)} className="mt-0.5" />
                  <span>Es una corrección de datos, <strong>no generar</strong> movimiento IMSS</span>
                </label>
              )}
            </Field>
            <Field label="Periodicidad">
              <select value={form.periodicidadPago} onChange={e => setForm(p => ({ ...p, periodicidadPago: e.target.value }))} className={inputCls}>
                <option value="01">Diario</option>
                <option value="02">Semanal</option>
                <option value="03">Catorcenal</option>
                <option value="04">Quincenal</option>
                <option value="05">Mensual</option>
              </select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Puesto"><input value={form.puesto} onChange={e => setForm(p => ({ ...p, puesto: e.target.value }))} className={inputCls} /></Field>
            <Field label="Departamento"><input value={form.departamento} onChange={e => setForm(p => ({ ...p, departamento: e.target.value }))} className={inputCls} /></Field>
          </div>

          {/* Datos bancarios (dispersión SPEI) */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="CLABE interbancaria">
              <input value={form.clabe}
                onChange={e => setForm(p => ({ ...p, clabe: e.target.value.replace(/\D/g, "").slice(0, 18) }))}
                className={inputCls} inputMode="numeric" placeholder="18 dígitos" maxLength={18} />
            </Field>
            <Field label="Banco">
              <select value={form.banco} onChange={e => setForm(p => ({ ...p, banco: e.target.value }))} className={inputCls}>
                <option value="">Sin especificar</option>
                {BANCOS.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
            </Field>
          </div>

          {/* Infonavit */}
          <details className="border border-cos-line rounded-lg" open={!!form.descuentoInfonavit}>
            <summary className="px-3 py-2 text-xs font-medium cursor-pointer hover:bg-cos-slate-tint flex items-center gap-2">
              <span>Infonavit</span>
              {form.descuentoInfonavit && (
                <span className="text-[10px] bg-cos-jade-tint text-cos-jade-ink px-1.5 py-0.5 rounded-full font-medium">
                  ${form.descuentoInfonavit}
                </span>
              )}
            </summary>
            <div className="px-3 pb-3 pt-1 space-y-2 border-t border-cos-line">
              <div className="grid grid-cols-3 gap-2">
                <Field label="N° crédito">
                  <input value={form.creditoInfonavit} onChange={e => setForm(p => ({ ...p, creditoInfonavit: e.target.value }))} className={inputCls} />
                </Field>
                <Field label="Tipo descuento">
                  <select value={form.tipoDescuentoInfonavit} onChange={e => setForm(p => ({ ...p, tipoDescuentoInfonavit: e.target.value }))} className={inputCls}>
                    <option value="">Sin crédito</option>
                    <option value="PESOS">Cuota fija ($)</option>
                    <option value="PCT_SBC">% del SBC</option>
                    <option value="VSM">VSM (veces UMA)</option>
                  </select>
                </Field>
                <Field label="Monto">
                  <input type="number" min="0" step="0.01" value={form.descuentoInfonavit}
                    onChange={e => setForm(p => ({ ...p, descuentoInfonavit: e.target.value }))} className={inputCls}
                    placeholder="1321.50" />
                </Field>
              </div>
            </div>
          </details>

          {err && <p className="text-xs text-cos-red-ink">{err}</p>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 border border-cos-line rounded-md py-2 text-sm">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 bg-cos-brand text-white rounded-md py-2 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Guardar cambios
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Baja Modal ─────────────────────────────────────────────────────────────
function BajaModal({
  companyId, employee, onClose, onDone,
}: { companyId: string; employee: Employee; onClose: () => void; onDone: (msg: string) => void }) {
  const [motivo, setMotivo] = useState<"VOLUNTARIA" | "JUSTIFICADA" | "INJUSTIFICADA">("VOLUNTARIA");
  const [fechaBaja, setFechaBaja] = useState(new Date().toISOString().slice(0, 10));
  const [diasPendientes, setDiasPendientes] = useState("0");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [result, setResult] = useState<any>(null);

  async function submit() {
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/nomina/baja", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          employeeId: employee.id,
          fechaBaja,
          motivo,
          diasSalarioPendiente: parseInt(diasPendientes) || 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error");
      setResult(data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  const f = result?.finiquito;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center pt-12 p-4 z-50 overflow-auto">
      <div className="bg-cos-card rounded-xl shadow-xl w-full max-w-lg">
        <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
          <h2 className="font-semibold text-cos-red-ink">Dar de baja</h2>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-cos-red-tint border border-cos-red-ink/20 rounded-lg px-4 py-3 text-sm">
            <p className="font-semibold text-cos-red-ink">{employee.nombre} {employee.apellidoPaterno}</p>
            <p className="text-xs text-cos-red-ink font-mono">{employee.rfc} · NSS {employee.nss}</p>
            <p className="text-xs text-cos-red-ink mt-0.5">Ingreso: {formatDate(employee.fechaIngreso)} · SBC: {formatCurrency(employee.salarioDiario)}/día</p>
          </div>

          {!result ? (
            <>
              <div>
                <label className="block text-xs font-medium mb-1">Motivo de baja</label>
                <select value={motivo} onChange={e => setMotivo(e.target.value as typeof motivo)}
                  className="w-full px-3 py-2 border border-cos-line rounded-md text-sm bg-cos-card">
                  <option value="VOLUNTARIA">Renuncia voluntaria</option>
                  <option value="JUSTIFICADA">Despido justificado (Art. 47 LFT)</option>
                  <option value="INJUSTIFICADA">Despido injustificado → Liquidación</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Fecha de baja</label>
                  <input type="date" value={fechaBaja} onChange={e => setFechaBaja(e.target.value)}
                    className="w-full px-3 py-2 border border-cos-line rounded-md text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Días de salario pendiente</label>
                  <input type="number" min="0" value={diasPendientes} onChange={e => setDiasPendientes(e.target.value)}
                    className="w-full px-3 py-2 border border-cos-line rounded-md text-sm" />
                </div>
              </div>
              {motivo === "INJUSTIFICADA" && (
                <div className="bg-cos-amber-tint border border-cos-amber-ink/20 rounded-md px-3 py-2 text-xs text-cos-amber-ink">
                  <p className="font-medium">Liquidación (Art. 50 LFT)</p>
                  <p>Incluye 3 meses de indemnización + 20 días por año + prima de antigüedad, además del finiquito base.</p>
                </div>
              )}
              {err && <p className="text-xs text-cos-red-ink">{err}</p>}
              <div className="flex gap-2">
                <button onClick={onClose} className="flex-1 border border-cos-line rounded-md py-2 text-sm">Cancelar</button>
                <button onClick={submit} disabled={saving}
                  className="flex-1 bg-cos-red-ink text-white rounded-md py-2 text-sm font-medium hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2">
                  {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                  Procesar baja
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="bg-cos-jade-tint border border-cos-jade-ink/20 rounded-md px-4 py-3 text-sm text-cos-jade-ink">
                <p className="font-medium">✓ Baja procesada</p>
                <p className="text-xs mt-0.5">{result.imssMovimiento}</p>
                <p className="text-xs">Antigüedad: {result.aniosAntiguedad} año(s)</p>
              </div>

              {f && (
                <div className="bg-cos-card border border-cos-line rounded-lg p-4 text-sm space-y-2">
                  <p className="font-semibold text-xs uppercase tracking-wide text-cos-ink-soft">Cálculo de finiquito</p>
                  <div className="space-y-1 text-xs">
                    {f.salariosPendientes > 0 && <Row label="Salarios pendientes" value={f.salariosPendientes} />}
                    <Row label="Aguinaldo proporcional" value={f.aguinaldoProporcional} />
                    <Row label="Vacaciones proporcionales" value={f.vacacionesProporcionales} />
                    <Row label="Prima vacacional" value={f.primaVacacional} />
                    <div className="border-t border-cos-line pt-1">
                      <Row label="Subtotal finiquito" value={f.subtotalFiniquito} bold />
                    </div>
                    {f.subtotalLiquidacion > 0 && (
                      <>
                        <div className="border-t border-cos-line pt-1 mt-1">
                          <p className="font-medium text-cos-red-ink mb-1">Liquidación</p>
                          <Row label="Indemnización 3 meses" value={f.indemnizacion3Meses} />
                          <Row label="20 días por año" value={f.indemnizacion20Dias} />
                          <Row label="Prima de antigüedad" value={f.primaAntiguedad} />
                        </div>
                        <div className="border-t border-cos-line pt-1">
                          <Row label="Subtotal liquidación" value={f.subtotalLiquidacion} bold />
                        </div>
                      </>
                    )}
                    <div className="border-t-2 border-cos-line pt-2 mt-2">
                      <Row label="Total bruto" value={f.totalBruto} bold />
                      <Row label="Exento de ISR" value={f.totalExento} muted />
                      <Row label="Gravado" value={f.totalGravado} muted />
                    </div>
                  </div>
                </div>
              )}

              <button onClick={() => onDone(`${employee.nombre} ${employee.apellidoPaterno} dado de baja`)}
                className="w-full bg-cos-brand text-white rounded-md py-2 text-sm font-medium">
                Cerrar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, bold, muted }: { label: string; value: number; bold?: boolean; muted?: boolean }) {
  return (
    <div className={`flex justify-between ${bold ? "font-semibold" : ""} ${muted ? "text-cos-ink-soft" : ""}`}>
      <span>{label}</span>
      <span className="font-mono"><Money value={value} /></span>
    </div>
  );
}

const inputCls = "w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1">{label}</label>
      {children}
    </div>
  );
}

// ── New Payroll Run Modal ──────────────────────────────────────────────────
function NewRunModal({
  companyId, initial, onClose, onCreated,
}: { companyId: string; initial?: RunPrefill | null; onClose: () => void; onCreated: (warnings?: string[]) => void }) {
  const today = new Date();
  const isFirstHalf = today.getDate() <= 15;
  const pInicio = isFirstHalf
    ? new Date(today.getFullYear(), today.getMonth(), 1)
    : new Date(today.getFullYear(), today.getMonth(), 16);
  const pFin = isFirstHalf
    ? new Date(today.getFullYear(), today.getMonth(), 15)
    : new Date(today.getFullYear(), today.getMonth() + 1, 0);

  const [form, setForm] = useState({
    tipo: initial?.tipo ?? "ORDINARIA",
    periodoInicio: initial?.periodoInicio ?? pInicio.toISOString().slice(0, 10),
    periodoFin: initial?.periodoFin ?? pFin.toISOString().slice(0, 10),
    fechaPago: initial?.fechaPago ?? today.toISOString().slice(0, 10),
    diasPagados: initial ? String(initial.diasPagados) : "15",
    // Extraordinary fields
    diasAguinaldo: "15",
    utilidadFiscalGravable: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      const body: Record<string, unknown> = {
        companyId,
        tipo: form.tipo,
        periodoInicio: form.periodoInicio,
        periodoFin: form.periodoFin,
        fechaPago: form.fechaPago,
        diasPagados: parseInt(form.diasPagados),
      };
      // Prefill desde la corrida anterior: misma plantilla de empleados. El
      // motor recalcula ISR/IMSS con los datos vigentes — nada se copia ciego.
      if (initial?.employeeIds?.length) body.employeeIds = initial.employeeIds;
      if (form.tipo === "AGUINALDO") {
        body.diasAguinaldo = parseInt(form.diasAguinaldo);
        body.fechaCorte = `${today.getFullYear()}-12-31`;
      }
      if (form.tipo === "PTU" && form.utilidadFiscalGravable) {
        body.utilidadFiscalGravable = parseFloat(form.utilidadFiscalGravable);
      }
      const res = await fetch("/api/nomina/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error");
      // Avisos del motor (tarifa sin verificar, salarios bajo el mínimo) —
      // la corrida se crea igual, pero el contador debe verlos antes de timbrar.
      const warnings = [data.tarifaWarning, data.salarioMinimoWarning].filter(Boolean) as string[];
      onCreated(warnings);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center pt-12 p-4 z-50 overflow-auto">
      <div className="bg-cos-card rounded-xl shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
          <h2 className="font-semibold">Nueva corrida de nómina</h2>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-3">
          {initial && (
            <div className="bg-cos-brand-tint border border-cos-brand-ink/15 rounded-md px-3 py-2 text-xs text-cos-brand-ink">
              <p className="font-medium">Prellenada desde la corrida anterior ({initial.basadoEnPeriodo})</p>
              <p>
                Se copian los {initial.employeeIds.length} empleado{initial.employeeIds.length === 1 ? "" : "s"} y el periodo avanza una {initial.periodicidad === "SEMANAL" ? "semana" : initial.periodicidad === "MENSUAL" ? "mensualidad" : "quincena"}.
                {initial.omitidosPorBaja > 0 ? ` Se omitieron ${initial.omitidosPorBaja} por baja.` : ""}
                {" "}El ISR, IMSS e INFONAVIT se recalculan con los datos vigentes; las incidencias (faltas, horas extra) no se copian — captúralas por empleado en el detalle de la corrida una vez calculada.
              </p>
            </div>
          )}
          {!initial && form.tipo === "ORDINARIA" && (
            <div className="bg-cos-brand-tint border border-cos-brand-ink/15 rounded-md px-3 py-2 text-xs text-cos-brand-ink">
              <p>
                Las incidencias del periodo (faltas, horas extra, incapacidades, vacaciones, bonos y descuentos) se
                capturan por empleado en el detalle de la corrida una vez calculada; cada captura recalcula el recibo
                automáticamente antes de timbrar.
              </p>
            </div>
          )}
          <Field label="Tipo de corrida">
            <select value={form.tipo} onChange={e => setForm(p => ({ ...p, tipo: e.target.value }))} className={inputCls}>
              <option value="ORDINARIA">Ordinaria (quincenal/mensual)</option>
              <option value="AGUINALDO">Aguinaldo</option>
              <option value="VACACIONES">Vacaciones + Prima Vacacional</option>
              <option value="PTU">PTU (Reparto de utilidades)</option>
              <option value="EXTRAORDINARIA">Extraordinaria</option>
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Inicio del periodo">
              <input type="date" value={form.periodoInicio} onChange={e => setForm(p => ({ ...p, periodoInicio: e.target.value }))} className={inputCls} required />
            </Field>
            <Field label="Fin del periodo">
              <input type="date" value={form.periodoFin} onChange={e => setForm(p => ({ ...p, periodoFin: e.target.value }))} className={inputCls} required />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fecha de pago">
              <input type="date" value={form.fechaPago} onChange={e => setForm(p => ({ ...p, fechaPago: e.target.value }))} className={inputCls} required />
            </Field>
            <Field label="Días pagados">
              <input type="number" min="1" max="31" value={form.diasPagados} onChange={e => setForm(p => ({ ...p, diasPagados: e.target.value }))} className={inputCls} required />
            </Field>
          </div>

          {form.tipo === "AGUINALDO" && (
            <Field label="Días de aguinaldo (mínimo 15 LFT)">
              <input type="number" min="15" value={form.diasAguinaldo} onChange={e => setForm(p => ({ ...p, diasAguinaldo: e.target.value }))} className={inputCls} />
            </Field>
          )}

          {form.tipo === "PTU" && (
            <Field label="Utilidad fiscal gravable del ejercicio">
              <input type="number" min="0" step="0.01" value={form.utilidadFiscalGravable}
                onChange={e => setForm(p => ({ ...p, utilidadFiscalGravable: e.target.value }))} className={inputCls}
                placeholder="Se distribuye 10% entre empleados" required />
            </Field>
          )}

          {form.tipo === "AGUINALDO" && (
            <div className="bg-cos-brand-tint border border-cos-brand-ink/15 rounded-md px-3 py-2 text-xs text-cos-brand-ink">
              <p className="font-medium">Aguinaldo</p>
              <p>Mínimo 15 días de salario (Art. 87 LFT). Proporcional si el empleado tiene menos de 1 año. Exento hasta 30 UMA.</p>
            </div>
          )}

          {form.tipo === "PTU" && (
            <div className="bg-cos-brand-tint border border-cos-brand-ink/15 rounded-md px-3 py-2 text-xs text-cos-brand-ink">
              <p className="font-medium">PTU</p>
              <p>10% de la utilidad fiscal se reparte: 50% por días trabajados, 50% por salario. Exento hasta 15 UMA por empleado.</p>
            </div>
          )}

          {err && <p className="text-xs text-cos-red-ink">{err}</p>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 border border-cos-line rounded-md py-2 text-sm">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 bg-cos-brand text-white rounded-md py-2 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Calcular corrida
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── New Incidencia Modal ───────────────────────────────────────────────────
function NewIncidenciaModal({
  companyId, employees, onClose, onCreated,
}: { companyId: string; employees: Employee[]; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({
    employeeId: employees[0]?.id ?? "",
    tipo: "FALTA",
    fecha: new Date().toISOString().slice(0, 10),
    fechaFin: "",
    dias: "1",
    horas: "",
    horasTriples: "",
    monto: "",
    notas: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    try {
      const res = await fetch("/api/nomina/incidencias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          employeeId: form.employeeId,
          tipo: form.tipo,
          fecha: form.fecha,
          fechaFin: form.fechaFin || undefined,
          dias: parseFloat(form.dias) || undefined,
          horas: form.horas ? parseFloat(form.horas) : undefined,
          horasTriples: form.horasTriples ? parseFloat(form.horasTriples) : undefined,
          monto: form.monto ? parseFloat(form.monto) : undefined,
          notas: form.notas || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error");
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center pt-12 p-4 z-50 overflow-auto">
      <div className="bg-cos-card rounded-xl shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
          <h2 className="font-semibold">Nueva incidencia</h2>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-3">
          <Field label="Empleado">
            <select value={form.employeeId} onChange={e => setForm(p => ({ ...p, employeeId: e.target.value }))} className={inputCls} required>
              {employees.map(emp => (
                <option key={emp.id} value={emp.id}>{emp.nombre} {emp.apellidoPaterno} — {emp.rfc}</option>
              ))}
            </select>
          </Field>
          <Field label="Tipo de incidencia">
            <select value={form.tipo} onChange={e => setForm(p => ({ ...p, tipo: e.target.value }))} className={inputCls}>
              {Object.entries(INCIDENCIA_LABEL).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fecha inicio">
              <input type="date" value={form.fecha} onChange={e => setForm(p => ({ ...p, fecha: e.target.value }))} className={inputCls} required />
            </Field>
            <Field label="Fecha fin (opcional)">
              <input type="date" value={form.fechaFin} onChange={e => setForm(p => ({ ...p, fechaFin: e.target.value }))} className={inputCls} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {INCIDENCIA_CON_DIAS.includes(form.tipo) && (
              <Field label="Días">
                <input type="number" min="0.5" step="0.5" value={form.dias} onChange={e => setForm(p => ({ ...p, dias: e.target.value }))} className={inputCls} />
              </Field>
            )}
            {(form.tipo === "HORAS_EXTRA" || form.tipo === "RETARDO") && (
              <Field label={form.tipo === "HORAS_EXTRA" ? "Horas dobles" : "Horas"}>
                <input type="number" min="0" step="0.5" value={form.horas} onChange={e => setForm(p => ({ ...p, horas: e.target.value }))} className={inputCls} />
              </Field>
            )}
            {form.tipo === "HORAS_EXTRA" && (
              <Field label="Horas triples (exceden el límite LFT)">
                <input type="number" min="0" step="0.5" value={form.horasTriples} onChange={e => setForm(p => ({ ...p, horasTriples: e.target.value }))} className={inputCls} />
              </Field>
            )}
            {INCIDENCIA_CON_MONTO.includes(form.tipo) && (
              <Field label="Monto (MXN)">
                <input type="number" min="0.01" step="0.01" value={form.monto} onChange={e => setForm(p => ({ ...p, monto: e.target.value }))} className={inputCls} required />
              </Field>
            )}
          </div>
          <Field label="Notas">
            <input value={form.notas} onChange={e => setForm(p => ({ ...p, notas: e.target.value }))} className={inputCls} placeholder="Opcional" />
          </Field>
          {err && <p className="text-xs text-cos-red-ink">{err}</p>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 border border-cos-line rounded-md py-2 text-sm">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 bg-cos-brand text-white rounded-md py-2 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Guardar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Incidencias por empleado dentro de una corrida ──────────────────────────
// Captura rápida entre el cálculo y el timbrado: cada alta/baja recalcula el
// recibo del empleado con el motor (nunca se editan importes a mano). El
// backend bloquea la mutación si la corrida ya se timbró.
function RunIncidenciasModal({
  companyId, runId, periodo, item, incidencias, onClose, onChanged,
}: {
  companyId: string;
  runId: string;
  periodo: string; // "YYYY-MM-DD/YYYY-MM-DD"
  item: PayrollItemDetail;
  incidencias: RunIncidencia[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [periodoInicio, periodoFin] = periodo.split("/");
  const [form, setForm] = useState({
    tipo: "FALTA",
    fecha: periodoInicio ?? new Date().toISOString().slice(0, 10),
    dias: "1",
    horas: "",
    horasTriples: "",
    monto: "",
    ramoImss: "02",
    folioImss: "",
    notas: "",
  });
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  async function agregar(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr("");
    setMsg("");
    try {
      const res = await fetch("/api/nomina/incidencias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId,
          payrollRunId: runId, // dispara el recálculo del empleado en el servidor
          employeeId: item.employeeId,
          tipo: form.tipo,
          fecha: form.fecha,
          dias: INCIDENCIA_CON_DIAS.includes(form.tipo) ? (parseFloat(form.dias) || 1) : undefined,
          horas: form.horas ? parseFloat(form.horas) : undefined,
          horasTriples: form.horasTriples ? parseFloat(form.horasTriples) : undefined,
          monto: form.monto ? parseFloat(form.monto) : undefined,
          ramoImss: form.tipo === "INCAPACIDAD" ? form.ramoImss : undefined,
          folioImss: form.tipo === "INCAPACIDAD" ? (form.folioImss || undefined) : undefined,
          notas: form.notas || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al capturar");
      setMsg(
        data.recalculo?.ok
          ? `Incidencia capturada — recibo recalculado (neto de la corrida: ${formatCurrency(data.recalculo.totalNeto ?? 0)}).`
          : "Incidencia capturada."
      );
      setForm(p => ({ ...p, dias: "1", horas: "", horasTriples: "", monto: "", folioImss: "", notas: "" }));
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al capturar");
    } finally {
      setSaving(false);
    }
  }

  async function eliminar(incidenciaId: string) {
    setDeletingId(incidenciaId);
    setErr("");
    setMsg("");
    try {
      const res = await fetch("/api/nomina/incidencias", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, action: "delete", incidenciaId, payrollRunId: runId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Error al eliminar");
      setMsg("Incidencia eliminada — recibo recalculado.");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Error al eliminar");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center pt-12 p-4 z-50 overflow-auto">
      <div className="bg-cos-card rounded-xl shadow-xl w-full max-w-lg">
        <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Incidencias — {item.employee.nombre} {item.employee.apellidoPaterno}</h2>
            <p className="text-xs text-cos-ink-soft mt-0.5">Periodo {periodo} · neto actual {formatCurrency(item.netoAPagar)}</p>
          </div>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          {/* Incidencias ya capturadas en el periodo */}
          {incidencias.length === 0 ? (
            <p className="text-xs text-cos-ink-soft">Sin incidencias capturadas en este periodo.</p>
          ) : (
            <div className="border border-cos-line rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <tbody>
                  {incidencias.map(inc => (
                    <tr key={inc.id} className="border-b border-cos-line last:border-0">
                      <td className="px-3 py-2 font-medium">{INCIDENCIA_LABEL[inc.tipo] ?? inc.tipo}</td>
                      <td className="px-3 py-2 text-cos-ink-soft">{formatDate(inc.fecha)}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {INCIDENCIA_CON_MONTO.includes(inc.tipo)
                          ? formatCurrency(inc.monto ?? 0)
                          : inc.tipo === "HORAS_EXTRA"
                            ? `${inc.horas ?? 0} h${inc.horasTriples ? ` + ${inc.horasTriples} h triples` : ""}`
                            : `${inc.dias} día${inc.dias === 1 ? "" : "s"}`}
                        {inc.tipo === "INCAPACIDAD" && inc.ramoImss && (
                          <span className="text-cos-ink-soft font-sans ml-1">({RAMO_IMSS_LABEL[inc.ramoImss] ?? inc.ramoImss})</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => eliminar(inc.id)} disabled={deletingId === inc.id}
                          className="text-cos-red-ink hover:bg-cos-red-tint rounded p-1 disabled:opacity-50"
                          title="Eliminar y recalcular">
                          {deletingId === inc.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Captura */}
          <form onSubmit={agregar} className="space-y-3 border-t border-cos-line pt-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tipo de incidencia">
                <select value={form.tipo} onChange={e => setForm(p => ({ ...p, tipo: e.target.value }))} className={inputCls}>
                  {Object.entries(INCIDENCIA_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </Field>
              <Field label="Fecha (dentro del periodo)">
                <input type="date" value={form.fecha} min={periodoInicio} max={periodoFin}
                  onChange={e => setForm(p => ({ ...p, fecha: e.target.value }))} className={inputCls} required />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {INCIDENCIA_CON_DIAS.includes(form.tipo) && (
                <Field label="Días">
                  <input type="number" min="0.5" step="0.5" value={form.dias}
                    onChange={e => setForm(p => ({ ...p, dias: e.target.value }))} className={inputCls} required />
                </Field>
              )}
              {(form.tipo === "HORAS_EXTRA" || form.tipo === "RETARDO") && (
                <Field label={form.tipo === "HORAS_EXTRA" ? "Horas dobles" : "Horas"}>
                  <input type="number" min="0" step="0.5" value={form.horas}
                    onChange={e => setForm(p => ({ ...p, horas: e.target.value }))} className={inputCls} />
                </Field>
              )}
              {form.tipo === "HORAS_EXTRA" && (
                <Field label="Horas triples (exceden el límite LFT)">
                  <input type="number" min="0" step="0.5" value={form.horasTriples}
                    onChange={e => setForm(p => ({ ...p, horasTriples: e.target.value }))} className={inputCls} />
                </Field>
              )}
              {INCIDENCIA_CON_MONTO.includes(form.tipo) && (
                <Field label="Monto (MXN)">
                  <input type="number" min="0.01" step="0.01" value={form.monto}
                    onChange={e => setForm(p => ({ ...p, monto: e.target.value }))} className={inputCls} required />
                </Field>
              )}
              {form.tipo === "INCAPACIDAD" && (
                <>
                  <Field label="Ramo IMSS">
                    <select value={form.ramoImss} onChange={e => setForm(p => ({ ...p, ramoImss: e.target.value }))} className={inputCls}>
                      {Object.entries(RAMO_IMSS_LABEL).map(([k, v]) => (
                        <option key={k} value={k}>{v}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Folio IMSS (opcional)">
                    <input value={form.folioImss} onChange={e => setForm(p => ({ ...p, folioImss: e.target.value }))} className={inputCls} />
                  </Field>
                </>
              )}
            </div>
            <Field label="Notas">
              <input value={form.notas} onChange={e => setForm(p => ({ ...p, notas: e.target.value }))} className={inputCls} placeholder="Opcional" />
            </Field>
            {err && <p className="text-xs text-cos-red-ink">{err}</p>}
            {msg && <p className="text-xs text-cos-jade-ink">{msg}</p>}
            <div className="flex gap-2 pt-1">
              <button type="button" onClick={onClose} className="flex-1 border border-cos-line rounded-md py-2 text-sm">Cerrar</button>
              <button type="submit" disabled={saving}
                className="flex-1 bg-cos-brand text-white rounded-md py-2 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                Agregar y recalcular
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
