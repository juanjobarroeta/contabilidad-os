"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Modales de corridas del hub de Nómina: nueva corrida (con prefill «Iniciar
// desde la quincena anterior»), incidencia suelta del periodo y captura de
// incidencias por empleado dentro de una corrida (con recálculo automático).
// Extraídos SIN CAMBIOS del antiguo workspace /nomina/detalle.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import { Loader2, X, Trash2 } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Field, inputCls,
  INCIDENCIA_LABEL, INCIDENCIA_CON_DIAS, INCIDENCIA_CON_MONTO, RAMO_IMSS_LABEL,
  type Employee, type PayrollItemDetail, type RunIncidencia, type RunPrefill,
} from "./workspace-shared";

// ── New Payroll Run Modal ──────────────────────────────────────────────────
export function NewRunModal({
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
export function NewIncidenciaModal({
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
export function RunIncidenciasModal({
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
