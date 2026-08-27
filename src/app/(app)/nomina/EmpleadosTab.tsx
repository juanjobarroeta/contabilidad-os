"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Pestaña Empleados del hub de Nómina — el roster que antes vivía en
// /nomina/detalle, ahora con búsqueda, columnas de expediente (RFC, NSS, SBC,
// estado, último recibo) y enlace al expediente de cada empleado. Conserva
// intactas las acciones existentes: alta (manual o desde documentos con IA),
// importación desde recibos timbrados, edición, emisión de recibo y baja con
// finiquito.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Alert, EmptyState, Money, RetryButton } from "@/components/ui";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatDate } from "@/lib/utils";
import {
  Plus, Users2, Loader2, X, AlertCircle, CheckCircle2, Receipt,
  UserX, Wand2, Search, Pencil, ChevronRight,
} from "lucide-react";
import { RosterImport } from "./RosterImport";
import { PERIODICIDAD_LABEL, type Employee } from "./workspace-shared";
import { NewEmployeeModal, EditEmployeeModal, BajaModal, EmitNominaModal } from "./EmployeeModals";

export default function EmpleadosTab() {
  const { activeCompany } = useCompany();
  const [employees, setEmployees] = useState<Employee[]>([]);
  // Arranca en true: antes de la primera carga la pantalla NO debe verse como
  // «Sin empleados» (no-cargado ≠ vacío).
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Error de carga del roster — distinto del banner de acciones (`error`):
  // se renderiza EN LUGAR del vacío, para no invitar a re-importar el equipo
  // por un fallo de red.
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [emitFor, setEmitFor] = useState<Employee | null>(null);
  const [editFor, setEditFor] = useState<Employee | null>(null);
  const [bajaFor, setBajaFor] = useState<Employee | null>(null);
  const [showImport, setShowImport] = useState(false);

  const loadEmployees = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setLoadError(false);
    try {
      // includeInactive: el roster del hub también muestra bajas (expediente).
      const res = await fetch(`/api/empleados?companyId=${activeCompany.id}&includeInactive=1&withUltimoRecibo=1`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setEmployees(Array.isArray(data) ? data : []);
    } catch { setLoadError(true); }
    finally { setLoading(false); }
  }, [activeCompany]);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return employees;
    return employees.filter(e =>
      `${e.nombre} ${e.apellidoPaterno} ${e.apellidoMaterno ?? ""}`.toLowerCase().includes(s) ||
      e.rfc.toLowerCase().includes(s) ||
      (e.nss ?? "").toLowerCase().includes(s) ||
      (e.puesto ?? "").toLowerCase().includes(s)
    );
  }, [employees, q]);

  if (!activeCompany) {
    return <div className="p-8 text-cos-ink-soft text-sm">Selecciona una empresa para ver su nómina.</div>;
  }

  const activos = employees.filter(e => e.isActive).length;
  const bajas = employees.length - activos;

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold">Empleados</h1>
          <p className="text-sm text-cos-ink-soft mt-0.5">
            {activeCompany.razonSocial}
            {/* Conteos sólo con datos reales — no «0 activos» mientras carga o falló. */}
            {!loading && !loadError && ` · ${activos} activo${activos === 1 ? "" : "s"}`}
            {!loading && !loadError && bajas > 0 ? ` · ${bajas} baja${bajas === 1 ? "" : "s"}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setShowImport(true)} className="flex items-center gap-2 border border-cos-line px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-paper" title="Reconstruir el equipo desde tus recibos de nómina">
            <Wand2 className="h-4 w-4" /> Importar desde recibos
          </button>
          <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep">
            <Plus className="h-4 w-4" /> Nuevo empleado
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

      {/* búsqueda */}
      {employees.length > 0 && (
        <div className="relative mb-4 max-w-sm">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-cos-ink-faint" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar por nombre, RFC, NSS o puesto"
            className="w-full rounded-md border border-cos-line bg-cos-card py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30" />
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-cos-ink-soft text-sm py-12 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" /> Cargando empleados...
        </div>
      ) : loadError ? (
        /* Error ANTES que el vacío: un fallo de red jamás debe verse como
           «Sin empleados» con invitación a re-importar el roster. */
        <Alert tone="danger" action={<RetryButton onClick={loadEmployees} />}>
          No se pudieron cargar los empleados. Revisa tu conexión e inténtalo de nuevo.
        </Alert>
      ) : employees.length === 0 ? (
        <div className="bg-cos-card border border-dashed border-cos-line rounded-xl">
          <EmptyState
            icon={Users2}
            title="Sin empleados"
            description="Reconstruye tu equipo desde los recibos de nómina que ya timbraste, o agrégalo manualmente."
            action={
              <div className="flex items-center justify-center gap-2">
                <button onClick={() => setShowImport(true)} className="inline-flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep">
                  <Wand2 className="h-4 w-4" /> Importar desde recibos de nómina
                </button>
                <button onClick={() => setShowAdd(true)} className="inline-flex items-center gap-2 border border-cos-line px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-paper">
                  <Plus className="h-4 w-4" /> Nuevo empleado
                </button>
              </div>
            }
          />
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-10 text-center text-sm text-cos-ink-soft">
          Sin resultados para «{q}».
        </div>
      ) : (
        <div className="bg-cos-card border border-cos-line rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cos-line bg-cos-slate-tint">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Empleado</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">NSS</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Puesto</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft" title="Salario diario / Salario diario integrado (SBC)">Salario / SBC</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Periodicidad</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Estado</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Último recibo</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(e => (
                <tr key={e.id} className="border-b border-cos-line last:border-0 hover:bg-cos-slate-tint/50">
                  <td className="px-4 py-3">
                    <Link href={`/nomina/empleado/${e.id}`} className="group block text-left" title="Ver expediente del empleado">
                      <p className="font-medium group-hover:text-cos-brand-ink transition-colors inline-flex items-center gap-1">
                        {e.nombre} {e.apellidoPaterno} {e.apellidoMaterno ?? ""}
                        <ChevronRight className="h-3.5 w-3.5 text-cos-ink-faint opacity-0 group-hover:opacity-100 transition-opacity" />
                      </p>
                      <p className="text-xs text-cos-ink-soft font-mono">{e.rfc}</p>
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-xs font-mono">{e.nss || "—"}</td>
                  <td className="px-4 py-3 text-xs">{e.puesto ?? "—"}{e.departamento && <p className="text-cos-ink-soft">{e.departamento}</p>}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    <Money value={e.salarioDiario} />
                    {e.salarioDiarioIntegrado != null && (
                      <p className="text-cos-ink-soft" title="SBC (salario diario integrado)">SBC <Money value={e.salarioDiarioIntegrado} /></p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs">{PERIODICIDAD_LABEL[e.periodicidadPago] ?? e.periodicidadPago}</td>
                  <td className="px-4 py-3">
                    {e.isActive ? (
                      <span className="inline-flex rounded-full bg-cos-jade-tint px-2 py-0.5 text-[10px] font-medium text-cos-jade-ink">Activo</span>
                    ) : (
                      <span className="inline-flex rounded-full bg-cos-slate-tint px-2 py-0.5 text-[10px] font-medium text-cos-ink-soft" title={e.fechaBaja ? `Baja: ${formatDate(e.fechaBaja)}` : undefined}>Baja</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-cos-ink-soft">
                    {e.ultimoRecibo ? formatDate(e.ultimoRecibo.fechaPago) : "—"}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap space-x-1.5">
                    <button onClick={() => setEditFor(e)} className="text-xs border border-cos-line px-2.5 py-1.5 rounded-md hover:bg-cos-paper inline-flex items-center gap-1" title="Editar datos">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {e.isActive && (
                      <>
                        <button onClick={() => setEmitFor(e)} className="text-xs bg-cos-brand text-white px-3 py-1.5 rounded-md hover:bg-cos-brand-deep inline-flex items-center gap-1.5">
                          <Receipt className="h-3.5 w-3.5" /> Emitir recibo
                        </button>
                        <button onClick={() => setBajaFor(e)} className="text-xs border border-cos-red-ink/20 text-cos-red-ink px-2.5 py-1.5 rounded-md hover:bg-cos-red-tint inline-flex items-center gap-1"
                          title="Dar de baja">
                          <UserX className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
