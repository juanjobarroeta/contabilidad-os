"use client";

import { useCallback, useEffect, useState } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Plus, Users2, Loader2, X, AlertCircle, CheckCircle2, Receipt,
  Upload, Sparkles, FileText, Play, Download, Calendar, ClipboardList,
  ArrowLeftRight, Shield,
} from "lucide-react";

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
  DRAFT: "bg-gray-100 text-gray-600",
  CALCULATED: "bg-blue-100 text-blue-700",
  STAMPED: "bg-green-100 text-green-700",
  PAID: "bg-green-100 text-green-700",
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

  // Corridas state
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [showNewRun, setShowNewRun] = useState(false);
  const [stampingId, setStampingId] = useState<string | null>(null);

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
    return <div className="p-8 text-muted-foreground text-sm">Selecciona una empresa para ver su nómina.</div>;
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Nómina</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{activeCompany.razonSocial}</p>
        </div>
        <div className="flex items-center gap-2">
          {tab === "empleados" && (
            <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90">
              <Plus className="h-4 w-4" /> Nuevo empleado
            </button>
          )}
          {tab === "corridas" && (
            <>
              <button onClick={() => setShowNewRun(true)} className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90">
                <Plus className="h-4 w-4" /> Nueva corrida
              </button>
              <a href={`/api/nomina/sua-export?companyId=${activeCompany.id}&bimestre=${Math.ceil((now.getMonth() + 1) / 2)}&year=${now.getFullYear()}`}
                className="flex items-center gap-1.5 border border-border px-3 py-2 rounded-md text-xs hover:bg-accent" title="Exportar SUA">
                <Download className="h-3.5 w-3.5" /> SUA
              </a>
              <a href={`/api/nomina/imss-movimientos?companyId=${activeCompany.id}&format=idse&status=PENDING`}
                className="flex items-center gap-1.5 border border-border px-3 py-2 rounded-md text-xs hover:bg-accent" title="Exportar IDSE">
                <Shield className="h-3.5 w-3.5" /> IDSE
              </a>
            </>
          )}
          {tab === "incidencias" && (
            <button onClick={() => setShowNewInc(true)} className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90">
              <Plus className="h-4 w-4" /> Nueva incidencia
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-border mb-5">
        <div className="flex gap-1">
          {([
            ["empleados", "Empleados", Users2],
            ["corridas", "Corridas de nómina", Calendar],
            ["incidencias", "Incidencias", ClipboardList],
          ] as const).map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTab(id as TabId)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}>
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm mb-4 ${
          error.startsWith("✓") ? "bg-green-50 border border-green-200 text-green-700" : "bg-red-50 border border-red-200 text-red-700"
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
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-12 justify-center">
              <Loader2 className="h-5 w-5 animate-spin" /> Cargando empleados...
            </div>
          ) : employees.length === 0 ? (
            <div className="bg-white border border-dashed border-border rounded-xl p-12 text-center">
              <Users2 className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-30" />
              <p className="font-medium text-sm">Sin empleados</p>
              <p className="text-xs text-muted-foreground mt-1">Agrega tu primer empleado para empezar.</p>
              <button onClick={() => setShowAdd(true)} className="mt-4 inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90">
                <Plus className="h-4 w-4" /> Nuevo empleado
              </button>
            </div>
          ) : (
            <div className="bg-white border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-gray-50">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Empleado</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Puesto</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">SBC / día</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Periodicidad</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Ingreso</th>
                    <th className="px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map(e => (
                    <tr key={e.id} className="border-b border-border last:border-0 hover:bg-gray-50/50">
                      <td className="px-4 py-3">
                        <p className="font-medium">{e.nombre} {e.apellidoPaterno} {e.apellidoMaterno ?? ""}</p>
                        <p className="text-xs text-muted-foreground font-mono">{e.rfc}</p>
                      </td>
                      <td className="px-4 py-3 text-xs">{e.puesto ?? "—"}{e.departamento && <p className="text-muted-foreground">{e.departamento}</p>}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs">{formatCurrency(e.salarioDiario)}</td>
                      <td className="px-4 py-3 text-xs">{PERIODICIDAD_LABEL[e.periodicidadPago] ?? e.periodicidadPago}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(e.fechaIngreso)}</td>
                      <td className="px-4 py-3 text-right">
                        <button onClick={() => setEmitFor(e)} className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:bg-primary/90 inline-flex items-center gap-1.5">
                          <Receipt className="h-3.5 w-3.5" /> Emitir recibo
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
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-12 justify-center">
              <Loader2 className="h-5 w-5 animate-spin" /> Cargando corridas...
            </div>
          ) : runs.length === 0 ? (
            <div className="bg-white border border-dashed border-border rounded-xl p-12 text-center">
              <Calendar className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-30" />
              <p className="font-medium text-sm">Sin corridas de nómina</p>
              <p className="text-xs text-muted-foreground mt-1">Crea una corrida para calcular y timbrar la nómina de todos los empleados.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {runs.map(run => (
                <div key={run.id} className="bg-white border border-border rounded-xl p-4 flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-semibold text-sm">{TIPO_RUN_LABEL[run.tipo] ?? run.tipo}</span>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_RUN_COLOR[run.status] ?? "bg-gray-100"}`}>
                        {STATUS_RUN_LABEL[run.status] ?? run.status}
                      </span>
                      {run.extraData && !!(run.extraData as Record<string, unknown>).stampingInProgress && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700 flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Timbrado {String((run.extraData as Record<string, unknown>).stampedCount ?? 0)}/{String(run._count?.items ?? "?")}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{run.periodo}</p>
                    <div className="flex gap-4 mt-1 text-xs">
                      <span>Empleados: <strong>{run._count?.items ?? "—"}</strong></span>
                      <span>Percepciones: <strong>{formatCurrency(run.totalPercepciones)}</strong></span>
                      <span>Deducciones: <strong>{formatCurrency(run.totalDeducciones)}</strong></span>
                      <span>Neto: <strong className="text-green-700">{formatCurrency(run.totalNeto)}</strong></span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {run.status === "CALCULATED" && (
                      <button onClick={() => handleStamp(run.id)} disabled={stampingId === run.id}
                        className="flex items-center gap-1.5 bg-green-600 text-white px-3 py-1.5 rounded-md text-xs font-medium hover:bg-green-700 disabled:opacity-50">
                        {stampingId === run.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                        Timbrar todo
                      </button>
                    )}
                    {(run.status === "STAMPED" || run.status === "CALCULATED") && (
                      <a href={`/api/nomina/dispersion?runId=${run.id}`}
                        className="flex items-center gap-1.5 border border-border px-3 py-1.5 rounded-md text-xs hover:bg-accent">
                        <ArrowLeftRight className="h-3.5 w-3.5" /> Dispersión
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Incidencias Tab ── */}
      {tab === "incidencias" && (
        <>
          <div className="flex items-center gap-2 mb-4">
            <label className="text-xs text-muted-foreground">Periodo:</label>
            <input type="month" value={incPeriodo} onChange={e => setIncPeriodo(e.target.value)}
              className="text-sm border border-border rounded-md px-2 py-1.5 bg-white" />
          </div>
          {incLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm py-12 justify-center">
              <Loader2 className="h-5 w-5 animate-spin" /> Cargando...
            </div>
          ) : incidencias.length === 0 ? (
            <div className="bg-white border border-dashed border-border rounded-xl p-12 text-center">
              <ClipboardList className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-30" />
              <p className="font-medium text-sm">Sin incidencias en {incPeriodo}</p>
              <p className="text-xs text-muted-foreground mt-1">Registra faltas, incapacidades, horas extra y permisos.</p>
            </div>
          ) : (
            <div className="bg-white border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-gray-50">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Empleado</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Tipo</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Fecha</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Días</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Horas</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Notas</th>
                  </tr>
                </thead>
                <tbody>
                  {incidencias.map(inc => (
                    <tr key={inc.id} className="border-b border-border last:border-0 hover:bg-gray-50/50">
                      <td className="px-4 py-2.5">
                        <p className="text-xs font-medium">{inc.employee.nombre} {inc.employee.apellidoPaterno}</p>
                        <p className="text-[10px] text-muted-foreground font-mono">{inc.employee.rfc}</p>
                      </td>
                      <td className="px-4 py-2.5 text-xs">{INCIDENCIA_LABEL[inc.tipo] ?? inc.tipo}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">
                        {formatDate(inc.fecha)}
                        {inc.fechaFin && <> — {formatDate(inc.fechaFin)}</>}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs font-mono">{inc.dias}</td>
                      <td className="px-4 py-2.5 text-right text-xs font-mono">{inc.horas ?? "—"}</td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground truncate max-w-[200px]">{inc.notas ?? "—"}</td>
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
          onCreated={() => { setShowNewRun(false); loadRuns(); setError("✓ Corrida creada y calculada"); }} />
      )}
      {showNewInc && activeCompany && (
        <NewIncidenciaModal companyId={activeCompany.id} employees={employees}
          onClose={() => setShowNewInc(false)} onCreated={() => { setShowNewInc(false); loadIncidencias(); }} />
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
          salarioDiario: e.salarioDiario ? String(e.salarioDiario) : (e.salarioMensual ? String(Math.round((e.salarioMensual / 30.4) * 100) / 100) : prev.salarioDiario),
          periodicidadPago: e.periodicidadPago || prev.periodicidadPago,
          puesto: e.puesto?.trim() || prev.puesto,
          departamento: e.departamento?.trim() || prev.departamento,
          riesgoPuesto: prev.riesgoPuesto,
          claveEntFed: e.claveEntFed || prev.claveEntFed,
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
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-semibold">Nuevo empleado</h2>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <form onSubmit={submit} className="p-5 space-y-3">
          {/* AI Upload Zone */}
          <div className="bg-indigo-50/60 border border-indigo-200 rounded-lg p-3">
            <label className="flex items-center gap-3 px-3 py-2.5 border-2 border-dashed border-indigo-300 rounded-md text-sm bg-white cursor-pointer hover:bg-indigo-50/50 transition-colors">
              {aiParsing ? (
                <Loader2 className="h-4 w-4 text-indigo-600 shrink-0 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4 text-indigo-600 shrink-0" />
              )}
              <span className="text-muted-foreground truncate flex-1 text-xs">
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
                  <div key={i} className="flex items-center gap-2 text-[10px] text-indigo-800">
                    <FileText className="h-3 w-3" />
                    <span className="truncate">{d.name}</span>
                    <span className="text-indigo-600 font-medium">{d.type}</span>
                  </div>
                ))}
              </div>
            )}
            {aiWarnings.length > 0 && (
              <div className="mt-2 space-y-0.5">
                {aiWarnings.map((w, i) => (
                  <p key={i} className="text-[10px] text-amber-700">⚠ {w}</p>
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
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 border border-border rounded-md py-2 text-sm">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 bg-primary text-primary-foreground rounded-md py-2 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
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
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Emitir recibo de nómina</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
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
          <div className="bg-blue-50 border border-blue-200 rounded-md p-3 text-xs text-blue-900">
            <p className="font-medium mb-1">Cómo se calcula</p>
            <p>ISR: tarifa Art. 96 LISR + subsidio al empleo. IMSS: cuotas reales escalonadas (EyM, IyV, retiro, cesantía, guarderías) según clase de riesgo. Infonavit se deduce si el empleado tiene crédito activo. Exporta a SUA desde la pestaña Corridas.</p>
          </div>
          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 border border-border rounded-md py-2 text-sm">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 bg-primary text-primary-foreground rounded-md py-2 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Timbrar nómina
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const inputCls = "w-full px-3 py-2 border border-border rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";

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
}: { companyId: string; onClose: () => void; onCreated: () => void }) {
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
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
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
            <div className="bg-blue-50 border border-blue-200 rounded-md px-3 py-2 text-xs text-blue-800">
              <p className="font-medium">Aguinaldo</p>
              <p>Mínimo 15 días de salario (Art. 87 LFT). Proporcional si el empleado tiene menos de 1 año. Exento hasta 30 UMA.</p>
            </div>
          )}

          {form.tipo === "PTU" && (
            <div className="bg-blue-50 border border-blue-200 rounded-md px-3 py-2 text-xs text-blue-800">
              <p className="font-medium">PTU</p>
              <p>10% de la utilidad fiscal se reparte: 50% por días trabajados, 50% por salario. Exento hasta 15 UMA por empleado.</p>
            </div>
          )}

          {err && <p className="text-xs text-destructive">{err}</p>}
          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="flex-1 border border-border rounded-md py-2 text-sm">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 bg-primary text-primary-foreground rounded-md py-2 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
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
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
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
            <button type="button" onClick={onClose} className="flex-1 border border-border rounded-md py-2 text-sm">Cancelar</button>
            <button type="submit" disabled={saving} className="flex-1 bg-primary text-primary-foreground rounded-md py-2 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Guardar
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
