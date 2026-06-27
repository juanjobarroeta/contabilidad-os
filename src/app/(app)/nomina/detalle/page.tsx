"use client";

import { useCallback, useEffect, useState } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Plus, Users2, Loader2, X, AlertCircle, CheckCircle2, Receipt,
  Upload, Sparkles, FileText, Play, Download, Calendar, ClipboardList,
  ArrowLeftRight, Shield, ChevronDown, ChevronUp, UserX, Trash2,
} from "lucide-react";

interface PayrollItemDetail {
  id: string;
  employeeId: string;
  sueldoBase: number;
  isrRetenido: number;
  imssObrero: number;
  imssPatronal: number;
  infonavit: number;
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
  createdAt: string;
  _count?: { items: number };
}

interface Incidencia {
  id: string;
  tipo: string;
  fecha: string;
  fechaFin: string | null;
  dias: number;
  horas: number | null;
  notas: string | null;
  periodo: string | null;
  employee: { nombre: string; apellidoPaterno: string; rfc: string };
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
  isActive: boolean;
}

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

  // Corridas state
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [showNewRun, setShowNewRun] = useState(false);
  const [stampingId, setStampingId] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [runItems, setRunItems] = useState<PayrollItemDetail[]>([]);
  const [runItemsLoading, setRunItemsLoading] = useState(false);

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

  async function toggleRunDetail(runId: string) {
    if (expandedRunId === runId) { setExpandedRunId(null); return; }
    setExpandedRunId(runId);
    setRunItemsLoading(true);
    try {
      const res = await fetch(`/api/nomina/run/${runId}`);
      const data = await res.json();
      setRunItems(data.items ?? []);
    } catch { setRunItems([]); }
    finally { setRunItemsLoading(false); }
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
            <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep">
              <Plus className="h-4 w-4" /> Nuevo empleado
            </button>
          )}
          {tab === "corridas" && (
            <>
              <button onClick={() => setShowNewRun(true)} className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep">
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
            <div className="bg-white border border-dashed border-cos-line rounded-xl p-12 text-center">
              <Users2 className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
              <p className="font-medium text-sm">Sin empleados</p>
              <p className="text-xs text-cos-ink-soft mt-1">Agrega tu primer empleado para empezar.</p>
              <button onClick={() => setShowAdd(true)} className="mt-4 inline-flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep">
                <Plus className="h-4 w-4" /> Nuevo empleado
              </button>
            </div>
          ) : (
            <div className="bg-white border border-cos-line rounded-xl overflow-hidden">
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
                      <td className="px-4 py-3 text-right font-mono text-xs">{formatCurrency(e.salarioDiario)}</td>
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
            <div className="bg-white border border-dashed border-cos-line rounded-xl p-12 text-center">
              <Calendar className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
              <p className="font-medium text-sm">Sin corridas de nómina</p>
              <p className="text-xs text-cos-ink-soft mt-1">Crea una corrida para calcular y timbrar la nómina de todos los empleados.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {runs.map(run => {
                const isExpanded = expandedRunId === run.id;
                return (
                  <div key={run.id} className="bg-white border border-cos-line rounded-xl overflow-hidden">
                    {/* Run header — clickable to expand */}
                    <div className="p-4 flex items-center gap-4 cursor-pointer hover:bg-cos-slate-tint/50" onClick={() => toggleRunDetail(run.id)}>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-semibold text-sm">{TIPO_RUN_LABEL[run.tipo] ?? run.tipo}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_RUN_COLOR[run.status] ?? "bg-cos-slate-tint"}`}>
                            {STATUS_RUN_LABEL[run.status] ?? run.status}
                          </span>
                          {run.extraData && !!(run.extraData as Record<string, unknown>).stampingInProgress && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-cos-amber-tint text-cos-amber-ink flex items-center gap-1">
                              <Loader2 className="h-3 w-3 animate-spin" />
                              Timbrado {String((run.extraData as Record<string, unknown>).stampedCount ?? 0)}/{String(run._count?.items ?? "?")}
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-cos-ink-soft">{run.periodo}</p>
                        <div className="flex gap-4 mt-1 text-xs">
                          <span>Empleados: <strong>{run._count?.items ?? "—"}</strong></span>
                          <span>Percepciones: <strong>{formatCurrency(run.totalPercepciones)}</strong></span>
                          <span>Deducciones: <strong>{formatCurrency(run.totalDeducciones)}</strong></span>
                          <span>Neto: <strong className="text-cos-jade-ink">{formatCurrency(run.totalNeto)}</strong></span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                        {run.status === "CALCULATED" && (
                          <button onClick={() => handleStamp(run.id)} disabled={stampingId === run.id}
                            className="flex items-center gap-1.5 bg-cos-jade-ink text-white px-3 py-1.5 rounded-md text-xs font-medium hover:opacity-90 disabled:opacity-50">
                            {stampingId === run.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                            Timbrar todo
                          </button>
                        )}
                        {(run.status === "STAMPED" || run.status === "CALCULATED") && (
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
                                  <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">ISR</th>
                                  <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">IMSS Obr.</th>
                                  <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">IMSS Pat.</th>
                                  <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">Infonavit</th>
                                  {run.tipo === "AGUINALDO" && <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">Aguinaldo</th>}
                                  {run.tipo === "PTU" && <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">PTU</th>}
                                  <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">Percepciones</th>
                                  <th className="text-right px-3 py-2 font-medium text-cos-ink-soft">Deducciones</th>
                                  <th className="text-right px-3 py-2 font-medium text-cos-ink-soft font-bold">Neto</th>
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
                                    <td className="px-3 py-2 text-right font-mono">{formatCurrency(item.sueldoBase)}</td>
                                    <td className="px-3 py-2 text-right font-mono">{item.isrRetenido > 0 ? formatCurrency(item.isrRetenido) : "—"}</td>
                                    <td className="px-3 py-2 text-right font-mono">{item.imssObrero > 0 ? formatCurrency(item.imssObrero) : "—"}</td>
                                    <td className="px-3 py-2 text-right font-mono text-cos-ink-soft">{item.imssPatronal > 0 ? formatCurrency(item.imssPatronal) : "—"}</td>
                                    <td className="px-3 py-2 text-right font-mono">{item.infonavit > 0 ? formatCurrency(item.infonavit) : "—"}</td>
                                    {run.tipo === "AGUINALDO" && <td className="px-3 py-2 text-right font-mono">{item.aguinaldo > 0 ? formatCurrency(item.aguinaldo) : "—"}</td>}
                                    {run.tipo === "PTU" && <td className="px-3 py-2 text-right font-mono">{item.ptu > 0 ? formatCurrency(item.ptu) : "—"}</td>}
                                    <td className="px-3 py-2 text-right font-mono">{formatCurrency(item.totalPercepciones)}</td>
                                    <td className="px-3 py-2 text-right font-mono text-cos-red-ink">{formatCurrency(item.totalDeducciones)}</td>
                                    <td className="px-3 py-2 text-right font-mono font-bold text-cos-jade-ink">{formatCurrency(item.netoAPagar)}</td>
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
                                    <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + i.isrRetenido, 0))}</td>
                                    <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + i.imssObrero, 0))}</td>
                                    <td className="px-3 py-2 text-right font-mono text-cos-ink-soft">{formatCurrency(runItems.reduce((s, i) => s + i.imssPatronal, 0))}</td>
                                    <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + i.infonavit, 0))}</td>
                                    {run.tipo === "AGUINALDO" && <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + i.aguinaldo, 0))}</td>}
                                    {run.tipo === "PTU" && <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + i.ptu, 0))}</td>}
                                    <td className="px-3 py-2 text-right font-mono">{formatCurrency(runItems.reduce((s, i) => s + i.totalPercepciones, 0))}</td>
                                    <td className="px-3 py-2 text-right font-mono text-cos-red-ink">{formatCurrency(runItems.reduce((s, i) => s + i.totalDeducciones, 0))}</td>
                                    <td className="px-3 py-2 text-right font-mono font-bold text-cos-jade-ink">{formatCurrency(runItems.reduce((s, i) => s + i.netoAPagar, 0))}</td>
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
              className="text-sm border border-cos-line rounded-md px-2 py-1.5 bg-white" />
          </div>
          {incLoading ? (
            <div className="flex items-center gap-2 text-cos-ink-soft text-sm py-12 justify-center">
              <Loader2 className="h-5 w-5 animate-spin" /> Cargando...
            </div>
          ) : incidencias.length === 0 ? (
            <div className="bg-white border border-dashed border-cos-line rounded-xl p-12 text-center">
              <ClipboardList className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
              <p className="font-medium text-sm">Sin incidencias en {incPeriodo}</p>
              <p className="text-xs text-cos-ink-soft mt-1">Registra faltas, incapacidades, horas extra y permisos.</p>
            </div>
          ) : (
            <div className="bg-white border border-cos-line rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-cos-line bg-cos-slate-tint">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Empleado</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Tipo</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Fecha</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Días</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Horas</th>
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
                      <td className="px-4 py-2.5 text-right text-xs font-mono">{inc.horas ?? "—"}</td>
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
      {showAdd && activeCompany && (
        <NewEmployeeModal companyId={activeCompany.id} onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); loadEmployees(); }} />
      )}
      {emitFor && activeCompany && (
        <EmitNominaModal companyId={activeCompany.id} employee={emitFor}
          onClose={() => setEmitFor(null)} onEmitted={(msg) => { setEmitFor(null); setError(`✓ ${msg}`); }} />
      )}
      {showNewRun && activeCompany && (
        <NewRunModal companyId={activeCompany.id} onClose={() => setShowNewRun(false)}
          onCreated={(warnings) => {
            setShowNewRun(false);
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
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
          <h2 className="font-semibold">Nuevo empleado</h2>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-3">
          {/* AI Upload Zone */}
          <div className="bg-cos-brand-tint/60 border border-cos-brand-ink/15 rounded-lg p-3">
            <label className="flex items-center gap-3 px-3 py-2.5 border-2 border-dashed border-cos-brand-ink/15 rounded-md text-sm bg-white cursor-pointer hover:bg-cos-brand-tint/50 transition-colors">
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

          {err && <p className="text-xs text-destructive">{err}</p>}
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
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
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
          {err && <p className="text-xs text-destructive">{err}</p>}
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
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
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

          {err && <p className="text-xs text-destructive">{err}</p>}
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
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
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
                  className="w-full px-3 py-2 border border-cos-line rounded-md text-sm bg-white">
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
              {err && <p className="text-xs text-destructive">{err}</p>}
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
                <div className="bg-white border border-cos-line rounded-lg p-4 text-sm space-y-2">
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
      <span className="font-mono">{formatCurrency(value)}</span>
    </div>
  );
}

const inputCls = "w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";

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
  companyId, onClose, onCreated,
}: { companyId: string; onClose: () => void; onCreated: (warnings?: string[]) => void }) {
  const today = new Date();
  const isFirstHalf = today.getDate() <= 15;
  const pInicio = isFirstHalf
    ? new Date(today.getFullYear(), today.getMonth(), 1)
    : new Date(today.getFullYear(), today.getMonth(), 16);
  const pFin = isFirstHalf
    ? new Date(today.getFullYear(), today.getMonth(), 15)
    : new Date(today.getFullYear(), today.getMonth() + 1, 0);

  const [form, setForm] = useState({
    tipo: "ORDINARIA",
    periodoInicio: pInicio.toISOString().slice(0, 10),
    periodoFin: pFin.toISOString().slice(0, 10),
    fechaPago: today.toISOString().slice(0, 10),
    diasPagados: "15",
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
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
          <h2 className="font-semibold">Nueva corrida de nómina</h2>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-3">
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

          {err && <p className="text-xs text-destructive">{err}</p>}
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
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
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
            <Field label="Días">
              <input type="number" min="0.5" step="0.5" value={form.dias} onChange={e => setForm(p => ({ ...p, dias: e.target.value }))} className={inputCls} />
            </Field>
            {(form.tipo === "HORAS_EXTRA" || form.tipo === "RETARDO") && (
              <Field label="Horas">
                <input type="number" min="0" step="0.5" value={form.horas} onChange={e => setForm(p => ({ ...p, horas: e.target.value }))} className={inputCls} />
              </Field>
            )}
          </div>
          <Field label="Notas">
            <input value={form.notas} onChange={e => setForm(p => ({ ...p, notas: e.target.value }))} className={inputCls} placeholder="Opcional" />
          </Field>
          {err && <p className="text-xs text-destructive">{err}</p>}
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
