"use client";

import { useCallback, useEffect, useState } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Plus, Users2, Loader2, X, AlertCircle, CheckCircle2, Receipt,
} from "lucide-react";

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
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [emitFor, setEmitFor] = useState<Employee | null>(null);

  const loadEmployees = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/empleados?companyId=${activeCompany.id}`);
      const data = await res.json();
      setEmployees(Array.isArray(data) ? data : []);
    } catch {
      setError("Error al cargar empleados");
    } finally {
      setLoading(false);
    }
  }, [activeCompany]);

  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  if (!activeCompany) {
    return (
      <div className="p-8 text-muted-foreground text-sm">
        Selecciona una empresa para ver su nómina.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Nómina</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{activeCompany.razonSocial}</p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" /> Nuevo empleado
        </button>
      </div>

      {error && (
        <div className={`flex items-center gap-2 rounded-lg px-4 py-3 text-sm mb-4 ${
          error.startsWith("✓")
            ? "bg-green-50 border border-green-200 text-green-700"
            : "bg-red-50 border border-red-200 text-red-700"
        }`}>
          {error.startsWith("✓") ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-12 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" /> Cargando empleados...
        </div>
      ) : employees.length === 0 ? (
        <div className="bg-white border border-dashed border-border rounded-xl p-12 text-center">
          <Users2 className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-30" />
          <p className="font-medium text-sm">Sin empleados</p>
          <p className="text-xs text-muted-foreground mt-1">Agrega tu primer empleado para empezar a emitir recibos de nómina.</p>
          <button
            onClick={() => setShowAdd(true)}
            className="mt-4 inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90"
          >
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
                  <td className="px-4 py-3 text-xs">
                    {e.puesto ?? "—"}
                    {e.departamento && <p className="text-muted-foreground">{e.departamento}</p>}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">{formatCurrency(e.salarioDiario)}</td>
                  <td className="px-4 py-3 text-xs">{PERIODICIDAD_LABEL[e.periodicidadPago] ?? e.periodicidadPago}</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{formatDate(e.fechaIngreso)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setEmitFor(e)}
                      className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:bg-primary/90 inline-flex items-center gap-1.5"
                    >
                      <Receipt className="h-3.5 w-3.5" /> Emitir recibo
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && activeCompany && (
        <NewEmployeeModal
          companyId={activeCompany.id}
          onClose={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); loadEmployees(); }}
        />
      )}

      {emitFor && activeCompany && (
        <EmitNominaModal
          companyId={activeCompany.id}
          employee={emitFor}
          onClose={() => setEmitFor(null)}
          onEmitted={(msg) => { setEmitFor(null); setError(`✓ ${msg}`); }}
        />
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

  function set<K extends keyof typeof form>(k: K, v: string) {
    setForm(p => ({ ...p, [k]: v }));
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
            <p>El ISR se calcula con la tarifa Art. 96 LISR + subsidio para el empleo. El IMSS obrero usa 2.5% del SBC × días (aproximación). La cuota patronal IMSS y SUA quedan a cargo del contador externo por ahora.</p>
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
