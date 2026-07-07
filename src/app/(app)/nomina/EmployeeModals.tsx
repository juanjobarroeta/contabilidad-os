"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Modales de empleado del hub de Nómina: alta (con lectura de documentos por
// IA), edición, baja (con finiquito) y emisión de recibo individual.
// Extraídos SIN CAMBIOS del antiguo workspace /nomina/detalle.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { Money } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Loader2, X, Sparkles, FileText } from "lucide-react";
import { BANCOS, Field, inputCls, type Employee } from "./workspace-shared";

// ── New Employee modal ───────────────────────────────────────────────────────
export function NewEmployeeModal({
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
export function EmitNominaModal({
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
export function EditEmployeeModal({
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
export function BajaModal({
  companyId, employee, onClose, onDone,
}: { companyId: string; employee: Employee; onClose: () => void; onDone: (msg: string) => void }) {
  const [motivo, setMotivo] = useState<"VOLUNTARIA" | "JUSTIFICADA" | "INJUSTIFICADA">("VOLUNTARIA");
  const [fechaBaja, setFechaBaja] = useState(new Date().toISOString().slice(0, 10));
  const [diasPendientes, setDiasPendientes] = useState("0");
  // Corrida FINIQUITO (recibo CFDI de separación): se crea CALCULATED y se
  // timbra después desde la pestaña de corridas — nunca se timbra aquí.
  const [crearCorrida, setCrearCorrida] = useState(true);
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
          crearCorridaFiniquito: crearCorrida,
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
              <label className="flex items-start gap-2 text-xs cursor-pointer">
                <input type="checkbox" checked={crearCorrida} onChange={e => setCrearCorrida(e.target.checked)}
                  className="mt-0.5 accent-cos-brand" />
                <span>
                  Crear la corrida de finiquito con este cálculo (recibo listo para timbrar el CFDI de
                  separación desde la pestaña de corridas)
                </span>
              </label>
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

              {result.finiquitoRun && (
                result.finiquitoRun.ok ? (
                  <div className="bg-cos-jade-tint border border-cos-jade-ink/20 rounded-md px-4 py-3 text-xs text-cos-jade-ink space-y-0.5">
                    <p className="font-medium">Corrida de finiquito creada</p>
                    <p>
                      Neto a pagar: <span className="font-mono">{formatCurrency(result.finiquitoRun.totalNeto ?? 0)}</span>
                      {" "}(ISR retenido incluido). Timbra el CFDI de separación desde la pestaña de corridas.
                    </p>
                    {result.finiquitoRun.tarifaWarning && (
                      <p className="text-cos-amber-ink">{result.finiquitoRun.tarifaWarning}</p>
                    )}
                  </div>
                ) : (
                  <div className="bg-cos-amber-tint border border-cos-amber-ink/20 rounded-md px-4 py-3 text-xs text-cos-amber-ink">
                    <p className="font-medium">No se pudo crear la corrida de finiquito</p>
                    <p>{result.finiquitoRun.error}</p>
                  </div>
                )
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
