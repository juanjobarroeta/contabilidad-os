"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency } from "@/lib/utils";
import { SatCodePicker } from "@/components/ui/SatCodePicker";
import {
  ChevronRight, ChevronLeft, Plus, Trash2, Loader2,
  CheckCircle2, Search, FileText, AlertCircle,
} from "lucide-react";

// ── SAT Catalogs ────────────────────────────────────────────────────────────

const FORMAS_PAGO = [
  { value: "01", label: "01 – Efectivo" },
  { value: "02", label: "02 – Cheque nominativo" },
  { value: "03", label: "03 – Transferencia electrónica de fondos" },
  { value: "04", label: "04 – Tarjeta de crédito" },
  { value: "28", label: "28 – Tarjeta de débito" },
  { value: "29", label: "29 – Tarjeta de servicios" },
  { value: "99", label: "99 – Por definir" },
];

const METODOS_PAGO = [
  { value: "PUE", label: "PUE – Pago en una sola exhibición" },
  { value: "PPD", label: "PPD – Pago en parcialidades o diferido" },
];

const USOS_CFDI = [
  { value: "G01", label: "G01 – Adquisición de mercancias" },
  { value: "G02", label: "G02 – Devoluciones, descuentos o bonificaciones" },
  { value: "G03", label: "G03 – Gastos en general" },
  { value: "I01", label: "I01 – Construcciones" },
  { value: "I03", label: "I03 – Equipo de transporte" },
  { value: "I04", label: "I04 – Equipo de cómputo y accesorios" },
  { value: "I08", label: "I08 – Otra maquinaria y equipo" },
  { value: "D01", label: "D01 – Honorarios médicos y gastos hospitalarios" },
  { value: "D03", label: "D03 – Gastos funerales" },
  { value: "D04", label: "D04 – Donativo" },
  { value: "D07", label: "D07 – Primas por seguros de gastos médicos" },
  { value: "D10", label: "D10 – Pagos por servicios educativos" },
  { value: "S01", label: "S01 – Sin efectos fiscales" },
  { value: "CP01", label: "CP01 – Pagos" },
  { value: "CN01", label: "CN01 – Nómina" },
];

// ── Types ───────────────────────────────────────────────────────────────────

interface Cliente {
  id: string;
  rfc: string;
  razonSocial: string;
  regimenFiscal: string;
  facturapiId?: string;
}

interface LineItem {
  id: string;
  description: string;
  product_key: string;
  unit_key: string;
  quantity: number;
  price: number;
  iva: boolean; // 16% IVA
}

function newItem(): LineItem {
  return {
    id: Math.random().toString(36).slice(2),
    description: "",
    product_key: "",
    unit_key: "E48",
    quantity: 1,
    price: 0,
    iva: true,
  };
}

const STEPS = [
  { id: 1, label: "Receptor" },
  { id: 2, label: "Conceptos" },
  { id: 3, label: "Resumen" },
];

// ── Component ────────────────────────────────────────────────────────────────

export default function NuevaFacturaPage() {
  const router = useRouter();
  const { activeCompany } = useCompany();

  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [needsReconfigure, setNeedsReconfigure] = useState(false);
  const [successId, setSuccessId] = useState<string | null>(null);

  // Step 1
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [clienteSearch, setClienteSearch] = useState("");
  const [selectedCliente, setSelectedCliente] = useState<Cliente | null>(null);
  const [formaPago, setFormaPago] = useState("03");
  const [metodoPago, setMetodoPago] = useState("PUE");
  const [usoCfdi, setUsoCfdi] = useState("G03");
  const [notas, setNotas] = useState("");
  // Información Global (required for XAXX010101000)
  const [globalPeriodicity, setGlobalPeriodicity] = useState("month");
  const [globalMonth, setGlobalMonth] = useState(String(new Date().getMonth() + 1).padStart(2, "0"));
  const [globalYear] = useState(new Date().getFullYear());

  const isPublicoGeneral = selectedCliente?.rfc === "XAXX010101000";

  // Step 2
  const [items, setItems] = useState<LineItem[]>([newItem()]);

  const fetchClientes = useCallback(async () => {
    if (!activeCompany) return;
    const res = await fetch(
      `/api/clientes?companyId=${activeCompany.id}&search=${encodeURIComponent(clienteSearch)}`
    );
    const data = await res.json();
    setClientes(data);
  }, [activeCompany, clienteSearch]);

  useEffect(() => { fetchClientes(); }, [fetchClientes]);

  // ── Calculations ──────────────────────────────────────────────────────────

  const subtotal = items.reduce((sum, it) => sum + it.quantity * it.price, 0);
  const ivaTotal = items
    .filter((it) => it.iva)
    .reduce((sum, it) => sum + it.quantity * it.price * 0.16, 0);
  const total = subtotal + ivaTotal;

  // ── Item helpers ──────────────────────────────────────────────────────────

  function updateItem(id: string, field: keyof LineItem, value: unknown) {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, [field]: value } : it)));
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }

  // ── Validation ────────────────────────────────────────────────────────────

  function validateStep1() {
    if (!selectedCliente) return "Selecciona un cliente receptor";
    if (!formaPago) return "Selecciona la forma de pago";
    if (!usoCfdi) return "Selecciona el uso del CFDI";
    if (isPublicoGeneral && !globalMonth) return "Selecciona el mes para Información Global";
    return null;
  }

  function validateStep2() {
    for (const it of items) {
      if (!it.description.trim()) return "Todos los conceptos requieren descripción";
      if (!it.product_key.trim()) return "Todos los conceptos requieren clave SAT";
      if (it.quantity <= 0) return "La cantidad debe ser mayor a 0";
      if (it.price <= 0) return "El precio debe ser mayor a 0";
    }
    if (items.length === 0) return "Agrega al menos un concepto";
    return null;
  }

  function handleNext() {
    setSubmitError("");
    if (step === 1) {
      const err = validateStep1();
      if (err) { setSubmitError(err); return; }
    }
    if (step === 2) {
      const err = validateStep2();
      if (err) { setSubmitError(err); return; }
    }
    setStep((s) => s + 1);
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async function handleStamp() {
    if (!activeCompany || !selectedCliente) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const payload = {
        companyId: activeCompany.id,
        customerId: selectedCliente.id,
        formaPago,
        metodoPago,
        usoCfdi,
        notes: notas || undefined,
        ...(isPublicoGeneral && {
          global: {
            periodicity: globalPeriodicity as "day" | "week" | "fortnight" | "month" | "two_months",
            months: globalMonth,
            year: globalYear,
          },
        }),
        items: items.map((it) => ({
          quantity: it.quantity,
          product: {
            description: it.description,
            product_key: it.product_key,
            price: it.price,
            unit_key: it.unit_key,
            tax_included: false,
            taxes: it.iva
              ? [{ type: "IVA", rate: 0.16, factor: "Tasa", withholding: false }]
              : [],
          },
        })),
      };

      const res = await fetch("/api/facturas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        if (data.needsReconfigure) setNeedsReconfigure(true);
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : "Error al timbrar. Verifica la configuración de Facturapi."
        );
      }

      const invoice = await res.json();
      setSuccessId(invoice.id);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setSubmitting(false);
    }
  }

  // ── Success screen ────────────────────────────────────────────────────────

  if (successId) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[60vh]">
        <div className="text-center max-w-sm">
          <div className="h-16 w-16 rounded-full bg-cos-jade-tint flex items-center justify-center mx-auto mb-4">
            <CheckCircle2 className="h-8 w-8 text-cos-jade-ink" />
          </div>
          <h2 className="text-xl font-bold mb-2">¡Factura timbrada!</h2>
          <p className="text-cos-ink-soft text-sm mb-6">
            El CFDI fue enviado al SAT exitosamente.
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => router.push("/facturas")}
              className="bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep"
            >
              Ver facturas
            </button>
            <button
              onClick={() => { setSuccessId(null); setStep(1); setItems([newItem()]); setSelectedCliente(null); }}
              className="px-4 py-2 rounded-md text-sm border border-cos-line hover:bg-cos-paper"
            >
              Nueva factura
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => router.push("/facturas")} className="text-cos-ink-soft hover:text-cos-ink text-sm">
          ← Facturas
        </button>
        <span className="text-cos-ink-soft">/</span>
        <h1 className="text-xl font-bold">Nueva Factura CFDI 4.0</h1>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 mb-8">
        {STEPS.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2">
            <div className={`h-7 w-7 rounded-full flex items-center justify-center text-xs font-bold ${
              step > s.id ? "bg-cos-jade-tint0 text-white" :
              step === s.id ? "bg-cos-brand text-white" :
              "bg-cos-slate-tint text-cos-ink-soft"
            }`}>
              {step > s.id ? <CheckCircle2 className="h-4 w-4" /> : s.id}
            </div>
            <span className={`text-sm ${step === s.id ? "font-medium text-cos-ink" : "text-cos-ink-soft"}`}>
              {s.label}
            </span>
            {i < STEPS.length - 1 && <ChevronRight className="h-4 w-4 text-cos-ink-soft mx-1" />}
          </div>
        ))}
      </div>

      <div className="bg-white border border-cos-line rounded-xl shadow-sm">

        {/* ── STEP 1: Receptor ── */}
        {step === 1 && (
          <div className="p-6 space-y-5">
            <h2 className="font-semibold text-base border-b border-cos-line pb-3">Datos del receptor</h2>

            {/* Cliente search */}
            <div>
              <label className="block text-sm font-medium mb-1.5">
                Cliente receptor <span className="text-cos-red-ink">*</span>
              </label>
              <div className="relative mb-2">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-cos-ink-soft" />
                <input
                  type="text" value={clienteSearch}
                  onChange={(e) => setClienteSearch(e.target.value)}
                  placeholder="Buscar cliente por RFC o Razón Social..."
                  className="w-full pl-9 pr-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>

              {selectedCliente && (
                <div className="flex items-center justify-between bg-cos-brand/5 border border-cos-brand/20 rounded-md px-4 py-2.5 mb-2">
                  <div>
                    <p className="text-sm font-medium">{selectedCliente.razonSocial}</p>
                    <p className="text-xs text-cos-ink-soft font-mono">{selectedCliente.rfc} · Régimen {selectedCliente.regimenFiscal}</p>
                    {!selectedCliente.facturapiId && (
                      <p className="text-xs text-cos-amber-ink mt-0.5 flex items-center gap-1">
                        <AlertCircle className="h-3 w-3" />
                        Sin sincronizar con Facturapi — no se podrá timbrar
                      </p>
                    )}
                  </div>
                  <button onClick={() => setSelectedCliente(null)} className="text-xs text-cos-ink-soft hover:text-cos-ink">
                    Cambiar
                  </button>
                </div>
              )}

              {!selectedCliente && clientes.length > 0 && (
                <div className="border border-cos-line rounded-md overflow-hidden max-h-48 overflow-y-auto">
                  {clientes.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => { setSelectedCliente(c); setClienteSearch(""); }}
                      className="w-full text-left px-4 py-2.5 hover:bg-cos-paper text-sm border-b border-cos-line last:border-0 transition-colors"
                    >
                      <span className="font-medium">{c.razonSocial}</span>
                      <span className="text-cos-ink-soft font-mono text-xs ml-2">{c.rfc}</span>
                      {!c.facturapiId && (
                        <span className="ml-2 text-xs text-cos-amber-ink">⚠ sin Facturapi</span>
                      )}
                    </button>
                  ))}
                </div>
              )}

              {!selectedCliente && clientes.length === 0 && (
                <p className="text-sm text-cos-ink-soft">
                  No hay clientes. <a href="/clientes" className="text-cos-brand-ink underline">Agrega uno primero</a>.
                </p>
              )}
            </div>

            {/* Forma + Método de pago */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">Forma de pago <span className="text-cos-red-ink">*</span></label>
                <select value={formaPago} onChange={(e) => setFormaPago(e.target.value)}
                  className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 bg-white">
                  {FORMAS_PAGO.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Método de pago <span className="text-cos-red-ink">*</span></label>
                <select value={metodoPago} onChange={(e) => setMetodoPago(e.target.value)}
                  className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 bg-white">
                  {METODOS_PAGO.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
            </div>

            {/* Uso CFDI */}
            <div>
              <label className="block text-sm font-medium mb-1.5">Uso del CFDI <span className="text-cos-red-ink">*</span></label>
              <select value={usoCfdi} onChange={(e) => setUsoCfdi(e.target.value)}
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 bg-white">
                {USOS_CFDI.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
              </select>
            </div>

            {/* Información Global — required for XAXX010101000 */}
            {isPublicoGeneral && (
              <div className="bg-cos-brand-tint border border-cos-brand-ink/15 rounded-lg p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-cos-brand-ink">Información Global</span>
                  <span className="text-xs bg-cos-brand-tint text-cos-brand-ink px-2 py-0.5 rounded-full">Requerido por SAT para Público en General</span>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1">Periodicidad</label>
                    <select value={globalPeriodicity} onChange={(e) => setGlobalPeriodicity(e.target.value)}
                      className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 bg-white">
                      <option value="day">Diario</option>
                      <option value="week">Semanal</option>
                      <option value="fortnight">Quincenal</option>
                      <option value="month">Mensual</option>
                      <option value="two_months">Bimestral</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">Mes / Período</label>
                    <select value={globalMonth} onChange={(e) => setGlobalMonth(e.target.value)}
                      className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 bg-white">
                      {globalPeriodicity === "two_months"
                        ? ["01","02","03","04","05","06"].map(m => (
                            <option key={m} value={m}>Bimestre {m}</option>
                          ))
                        : globalPeriodicity === "fortnight"
                        ? ["01","02"].map(m => (
                            <option key={m} value={m}>Quincena {m}</option>
                          ))
                        : [
                            ["01","Enero"],["02","Febrero"],["03","Marzo"],["04","Abril"],
                            ["05","Mayo"],["06","Junio"],["07","Julio"],["08","Agosto"],
                            ["09","Septiembre"],["10","Octubre"],["11","Noviembre"],["12","Diciembre"]
                          ].map(([v, l]) => <option key={v} value={v}>{l}</option>)
                      }
                    </select>
                  </div>
                </div>
                <p className="text-xs text-cos-brand-ink">Año: <strong>{globalYear}</strong></p>
              </div>
            )}

            {/* Notas */}
            <div>
              <label className="block text-sm font-medium mb-1.5">
                Notas <span className="text-cos-ink-soft font-normal text-xs">(opcional — aparece en el PDF)</span>
              </label>
              <input type="text" value={notas} onChange={(e) => setNotas(e.target.value)}
                placeholder="Información adicional para el receptor..."
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
          </div>
        )}

        {/* ── STEP 2: Conceptos ── */}
        {step === 2 && (
          <div className="p-6">
            <h2 className="font-semibold text-base border-b border-cos-line pb-3 mb-5">Conceptos (partidas)</h2>

            <div className="space-y-4">
              {items.map((item, idx) => (
                <div key={item.id} className="border border-cos-line rounded-lg p-4 space-y-3 relative">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-cos-ink-soft">Concepto {idx + 1}</span>
                    {items.length > 1 && (
                      <button onClick={() => removeItem(item.id)}
                        className="p-1 rounded hover:bg-cos-red-tint text-cos-ink-soft hover:text-cos-red-ink">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {/* Description */}
                  <div>
                    <label className="block text-xs font-medium mb-1">Descripción <span className="text-cos-red-ink">*</span></label>
                    <input type="text" value={item.description}
                      onChange={(e) => updateItem(item.id, "description", e.target.value)}
                      placeholder="Descripción del producto o servicio"
                      className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </div>

                  {/* Clave SAT + Unidad — searchable pickers backed by Facturapi catalog */}
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">Clave SAT <span className="text-cos-red-ink">*</span></label>
                      {activeCompany && (
                        <SatCodePicker
                          companyId={activeCompany.id}
                          endpoint="products"
                          value={item.product_key}
                          onChange={(key) => updateItem(item.id, "product_key", key)}
                          placeholder="Buscar producto/servicio…"
                          recentKey={`sat-recent-products-${activeCompany.id}`}
                        />
                      )}
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">Unidad <span className="text-cos-red-ink">*</span></label>
                      {activeCompany && (
                        <SatCodePicker
                          companyId={activeCompany.id}
                          endpoint="units"
                          value={item.unit_key}
                          onChange={(key) => updateItem(item.id, "unit_key", key)}
                          placeholder="Buscar unidad…"
                          recentKey={`sat-recent-units-${activeCompany.id}`}
                        />
                      )}
                    </div>
                  </div>

                  {/* Qty + Price + IVA */}
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs font-medium mb-1">Cantidad</label>
                      <input type="number" min="0.01" step="0.01" value={item.quantity}
                        onChange={(e) => updateItem(item.id, "quantity", parseFloat(e.target.value) || 0)}
                        className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">Precio unitario</label>
                      <input type="number" min="0.01" step="0.01" value={item.price}
                        onChange={(e) => updateItem(item.id, "price", parseFloat(e.target.value) || 0)}
                        className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                      />
                    </div>
                    <div className="flex flex-col justify-end">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={item.iva}
                          onChange={(e) => updateItem(item.id, "iva", e.target.checked)}
                          className="rounded border-cos-line" />
                        <span className="text-xs font-medium">IVA 16%</span>
                      </label>
                      <p className="text-xs text-cos-ink-soft mt-1">
                        Importe: <span className="font-medium">{formatCurrency(item.quantity * item.price)}</span>
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <button onClick={() => setItems((p) => [...p, newItem()])}
              className="mt-4 flex items-center gap-2 text-sm text-cos-brand-ink hover:text-cos-brand-ink/80 font-medium">
              <Plus className="h-4 w-4" />
              Agregar concepto
            </button>

            {/* Subtotals preview */}
            <div className="mt-6 bg-cos-slate-tint rounded-lg p-4 text-sm space-y-1.5 text-right">
              <div className="flex justify-between text-cos-ink-soft">
                <span>Subtotal</span><span>{formatCurrency(subtotal)}</span>
              </div>
              <div className="flex justify-between text-cos-ink-soft">
                <span>IVA 16%</span><span>{formatCurrency(ivaTotal)}</span>
              </div>
              <div className="flex justify-between font-semibold text-base pt-1 border-t border-cos-line">
                <span>Total</span><span>{formatCurrency(total)}</span>
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 3: Resumen + Timbrar ── */}
        {step === 3 && (
          <div className="p-6">
            <h2 className="font-semibold text-base border-b border-cos-line pb-3 mb-5">Resumen y timbrado</h2>

            {/* Summary card */}
            <div className="space-y-4">
              {/* Receptor */}
              <div className="bg-cos-slate-tint rounded-lg p-4">
                <p className="text-xs font-medium text-cos-ink-soft mb-2 uppercase tracking-wide">Receptor</p>
                <p className="font-semibold">{selectedCliente?.razonSocial}</p>
                <p className="text-sm text-cos-ink-soft font-mono">{selectedCliente?.rfc}</p>
              </div>

              {/* CFDI data */}
              <div className="bg-cos-slate-tint rounded-lg p-4 grid grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-xs text-cos-ink-soft mb-0.5">Forma de pago</p>
                  <p className="font-medium">{formaPago} – {FORMAS_PAGO.find(f => f.value === formaPago)?.label.split("–")[1]?.trim()}</p>
                </div>
                <div>
                  <p className="text-xs text-cos-ink-soft mb-0.5">Método de pago</p>
                  <p className="font-medium">{metodoPago}</p>
                </div>
                <div>
                  <p className="text-xs text-cos-ink-soft mb-0.5">Uso CFDI</p>
                  <p className="font-medium">{usoCfdi}</p>
                </div>
              </div>

              {/* Items */}
              <div className="border border-cos-line rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-cos-slate-tint border-b border-cos-line">
                      <th className="text-left px-4 py-2 text-xs font-medium text-cos-ink-soft">Descripción</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-cos-ink-soft">Cant.</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-cos-ink-soft">P. Unit.</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-cos-ink-soft">Importe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => (
                      <tr key={it.id} className="border-b border-cos-line last:border-0">
                        <td className="px-4 py-2.5">
                          <p className="font-medium">{it.description}</p>
                          <p className="text-xs text-cos-ink-soft">{it.product_key} · {it.unit_key}{it.iva ? " · IVA 16%" : " · Sin IVA"}</p>
                        </td>
                        <td className="px-4 py-2.5 text-right">{it.quantity}</td>
                        <td className="px-4 py-2.5 text-right">{formatCurrency(it.price)}</td>
                        <td className="px-4 py-2.5 text-right font-medium">{formatCurrency(it.quantity * it.price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="bg-cos-slate-tint rounded-lg p-4 text-sm space-y-1.5">
                <div className="flex justify-between text-cos-ink-soft">
                  <span>Subtotal</span><span>{formatCurrency(subtotal)}</span>
                </div>
                <div className="flex justify-between text-cos-ink-soft">
                  <span>IVA 16%</span><span>{formatCurrency(ivaTotal)}</span>
                </div>
                <div className="flex justify-between font-bold text-lg pt-1.5 border-t border-cos-line">
                  <span>Total</span><span>{formatCurrency(total)}</span>
                </div>
              </div>

              {/* Warning if no facturapi */}
              {selectedCliente && !selectedCliente.facturapiId && (
                <div className="flex items-start gap-3 bg-cos-amber-tint border border-cos-amber-ink/20 rounded-lg p-4 text-sm text-cos-amber-ink">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">Cliente sin Facturapi</p>
                    <p className="text-xs mt-0.5">Este cliente no está sincronizado con Facturapi. Edítalo desde Clientes para sincronizarlo antes de timbrar.</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Error ── */}
        {submitError && (
          <div className="mx-6 mb-4 bg-cos-red-tint border border-cos-red-ink/20 rounded-lg px-4 py-3 text-sm text-cos-red-ink">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p>{submitError}</p>
                {needsReconfigure && (
                  <a
                    href="/empresa"
                    className="inline-flex items-center gap-1.5 mt-2 text-xs font-medium bg-cos-red-ink text-white px-3 py-1.5 rounded hover:opacity-90"
                  >
                    Reconfigurar Facturapi
                  </a>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── Navigation ── */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-cos-line bg-cos-slate-tint rounded-b-xl">
          <button
            onClick={() => { setSubmitError(""); step > 1 ? setStep((s) => s - 1) : router.push("/facturas"); }}
            className="flex items-center gap-2 px-4 py-2 rounded-md text-sm border border-cos-line hover:bg-cos-paper"
          >
            <ChevronLeft className="h-4 w-4" />
            {step === 1 ? "Cancelar" : "Atrás"}
          </button>

          {step < 3 ? (
            <button onClick={handleNext}
              className="flex items-center gap-2 bg-cos-brand text-white px-5 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep">
              Continuar <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <button onClick={handleStamp} disabled={submitting}
              className="flex items-center gap-2 bg-cos-jade-ink text-white px-5 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
              {submitting ? "Timbrando..." : "Timbrar CFDI"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
