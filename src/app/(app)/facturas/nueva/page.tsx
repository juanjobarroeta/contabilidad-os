"use client";

import { useState, useEffect, useCallback } from "react";
import { Money } from "@/components/ui";
import { useRouter } from "next/navigation";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency } from "@/lib/utils";
import { SatCodePicker } from "@/components/ui/SatCodePicker";
import { contradiccionIva } from "@/lib/fiscal/iva-esperado";
import {
  MAX_LARGO_CUENTA_PREDIAL,
  avisoCuentaPredial,
  esClaveArrendamiento,
} from "@/lib/facturas/predial";
import {
  ChevronRight, ChevronLeft, Plus, Trash2, Loader2,
  CheckCircle2, Search, FileText, AlertCircle, History, Sparkles,
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
  // Tratamiento de IVA del concepto. "16" = tasa general; "0" = TASA CERO
  // (p.ej. agua, alimentos — Art. 2o.-A LIVA: acto gravado, IVA acreditable);
  // "EXENTO" = exento (el IVA de los gastos relacionados NO se acredita).
  // No es lo mismo tasa 0 que exento — facturar exento cuando corresponde
  // tasa 0 hace perder el acreditamiento.
  iva: "16" | "0" | "EXENTO";
  // Cuenta predial del inmueble arrendado (CFDI 4.0: nodo CuentaPredial del
  // concepto). Vacía en todo lo que no sea arrendamiento.
  cuentaPredial: string;
}

// ── Invoicing suggestions (sugerencias) ──────────────────────────────────────

interface ConceptoSugerido {
  claveProdServ: string;
  descripcion: string;
  valorUnitario: number;
  claveUnidad: string;
  vecesUsado: number;
  ultimoUso: string;
  // Tratamiento de IVA del uso más reciente del concepto (null = desconocido).
  ivaTratamiento?: "16" | "0" | "EXENTO" | null;
  cuentaPredial?: string | null;
}

interface FacturaPreviaItem {
  claveProdServ: string;
  descripcion: string;
  cantidad: number;
  valorUnitario: number;
  claveUnidad: string;
  cuentaPredial?: string | null;
}

/** Una forma de factura que la empresa repite — el atajo «vuelve a facturar». */
interface FacturaRecurrente {
  facturaId: string;
  customerId: string | null;
  cliente: string;
  total: number;
  veces: number;
  ultimoUso: string;
  items: FacturaPreviaItem[];
  ivaTratamiento: "16" | "0" | "EXENTO";
}

interface FacturaPrevia {
  id: string;
  folio: string | null;
  fecha: string;
  total: number;
  items: FacturaPreviaItem[];
  // Tratamiento de IVA derivado de los impuestos de la factura origen
  // (rate 0 + factor Tasa → "0"; factor Exento → "EXENTO"; ambiguo → "16").
  ivaTratamiento?: "16" | "0" | "EXENTO";
}

interface Sugerencias {
  conceptos: ConceptoSugerido[];
  facturasPrevias: FacturaPrevia[];
  recurrentes?: FacturaRecurrente[];
  // Último tratamiento de IVA que la empresa usó por clave de producto/servicio.
  tratamientoPorClave?: Record<string, "16" | "0" | "EXENTO">;
}

function newItem(): LineItem {
  return {
    id: Math.random().toString(36).slice(2),
    description: "",
    product_key: "",
    unit_key: "E48",
    quantity: 1,
    price: 0,
    iva: "16",
    cuentaPredial: "",
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
  // Prefactura guardada: enlace del PDF BORRADOR (7 días) + envío por correo.
  const [prefOk, setPrefOk] = useState<{ id: string; pdfUrl: string } | null>(null);
  const [savingPref, setSavingPref] = useState(false);
  const [prefMail, setPrefMail] = useState("");
  const [prefMailBusy, setPrefMailBusy] = useState(false);
  const [prefMailMsg, setPrefMailMsg] = useState("");

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

  // Sugerencias de facturación (conceptos recientes + facturas anteriores)
  const [sugerencias, setSugerencias] = useState<Sugerencias | null>(null);
  const [showFacturasPrevias, setShowFacturasPrevias] = useState(false);
  // Which line-item row currently has its concepto-autocomplete dropdown open.
  const [conceptoOpenFor, setConceptoOpenFor] = useState<string | null>(null);

  const fetchClientes = useCallback(async () => {
    if (!activeCompany) return;
    const res = await fetch(
      `/api/clientes?companyId=${activeCompany.id}&search=${encodeURIComponent(clienteSearch)}`
    );
    const data = await res.json();
    setClientes(data);
  }, [activeCompany, clienteSearch]);

  useEffect(() => { fetchClientes(); }, [fetchClientes]);

  // Deep-link «volver a facturar» desde el detalle de una factura
  // (/facturas/nueva?desde=<id>): clona esa factura tal cual. Se lee la URL
  // directamente para no forzar un límite de Suspense (useSearchParams).
  const [desdeId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("desde")
  );
  const [desdeAplicado, setDesdeAplicado] = useState(false);
  useEffect(() => {
    if (!desdeId || desdeAplicado || !activeCompany) return;
    let cancelado = false;
    (async () => {
      try {
        const res = await fetch(`/api/facturas/${desdeId}`);
        if (!res.ok) return;
        const f = await res.json();
        if (cancelado || !Array.isArray(f?.items) || f.items.length === 0) return;
        await refacturar({
          facturaId: f.id,
          customerId: f.customerId ?? null,
          cliente: f.customer?.razonSocial ?? "",
          total: f.total ?? 0,
          veces: 1,
          ultimoUso: f.fecha,
          ivaTratamiento: "16",
          items: f.items.map((it: FacturaPreviaItem) => ({
            claveProdServ: it.claveProdServ,
            descripcion: it.descripcion,
            cantidad: it.cantidad,
            valorUnitario: it.valorUnitario,
            claveUnidad: it.claveUnidad,
            cuentaPredial: it.cuentaPredial ?? null,
          })),
        });
      } finally {
        if (!cancelado) setDesdeAplicado(true);
      }
    })();
    return () => { cancelado = true; };
    // refacturar depende de `clientes`, que cambia con la búsqueda; el guard
    // desdeAplicado asegura que esto corra una sola vez.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desdeId, desdeAplicado, activeCompany]);

  // ── Sugerencias ─────────────────────────────────────────────────────────────
  // Fetch concepto suggestions + recent invoices whenever the company or the
  // selected customer changes. Additive: never blocks manual entry.
  useEffect(() => {
    if (!activeCompany) { setSugerencias(null); return; }
    let cancelled = false;
    const params = new URLSearchParams({ companyId: activeCompany.id });
    if (selectedCliente) params.set("customerId", selectedCliente.id);
    fetch(`/api/facturas/sugerencias?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Sugerencias | null) => { if (!cancelled) setSugerencias(data); })
      .catch(() => { if (!cancelled) setSugerencias(null); });
    setShowFacturasPrevias(false);
    return () => { cancelled = true; };
  }, [activeCompany, selectedCliente]);

  // Clone a past invoice's items into the form state (one-click prefill).
  function prefillFromFactura(f: FacturaPrevia) {
    if (f.items.length === 0) return;
    setItems(
      f.items.map((it) => ({
        id: Math.random().toString(36).slice(2),
        description: it.descripcion,
        product_key: it.claveProdServ,
        unit_key: it.claveUnidad || "E48",
        quantity: it.cantidad || 1,
        price: it.valorUnitario,
        // Se hereda el tratamiento de IVA de la factura origen (derivado de
        // sus impuestos timbrados) en lugar de asumir siempre 16%: quien
        // factura a tasa 0 o exento repite ese tratamiento mes a mes.
        iva: f.ivaTratamiento ?? "16",
        // La cuenta predial viaja con el concepto: el arrendamiento se
        // re-factura sin volver a teclear la cuenta catastral.
        cuentaPredial: it.cuentaPredial ?? "",
      }))
    );
    setShowFacturasPrevias(false);
    setSubmitError("");
  }

  /**
   * «Vuelve a facturar»: clona una forma de factura recurrente — cliente y
   * conceptos — y salta directo a la captura. El cliente puede no estar en la
   * lista cargada (depende del buscador), así que se pide por razón social y se
   * identifica por id, nunca por nombre.
   */
  async function refacturar(r: FacturaRecurrente) {
    setSubmitError("");
    let cliente = clientes.find((c) => c.id === r.customerId) ?? null;
    if (!cliente && r.customerId && activeCompany) {
      try {
        const res = await fetch(
          `/api/clientes?companyId=${activeCompany.id}&search=${encodeURIComponent(r.cliente)}`
        );
        const data = await res.json();
        cliente = Array.isArray(data)
          ? (data as Cliente[]).find((c) => c.id === r.customerId) ?? null
          : null;
      } catch {
        cliente = null;
      }
    }
    if (!cliente) {
      setSubmitError("No pude cargar el cliente de esa factura. Búscalo abajo y vuelve a intentar.");
      return;
    }
    setSelectedCliente(cliente);
    setClienteSearch("");
    setItems(
      r.items.map((it) => ({
        id: Math.random().toString(36).slice(2),
        description: it.descripcion,
        product_key: it.claveProdServ,
        unit_key: it.claveUnidad || "E48",
        quantity: it.cantidad || 1,
        price: it.valorUnitario,
        iva: r.ivaTratamiento,
        cuentaPredial: it.cuentaPredial ?? "",
      }))
    );
    setStep(2);
  }

  // Fill a line item from a concepto suggestion (clave + descripción + precio + unidad).
  function applyConcepto(itemId: string, c: ConceptoSugerido) {
    setItems((prev) =>
      prev.map((it) =>
        it.id === itemId
          ? {
              ...it,
              description: c.descripcion,
              product_key: c.claveProdServ,
              unit_key: c.claveUnidad || it.unit_key,
              price: c.valorUnitario,
              // Prellenado, no imposición: si el concepto trae el tratamiento
              // de IVA de su último uso lo sugerimos; el usuario puede cambiarlo.
              iva: c.ivaTratamiento ?? it.iva,
              cuentaPredial: c.cuentaPredial ?? it.cuentaPredial,
            }
          : it
      )
    );
    setConceptoOpenFor(null);
  }

  // Al elegir una clave SAT, además de fijarla, prellena el tratamiento de
  // IVA con el último que la empresa usó para esa clave en una factura
  // timbrada (si se conoce). Solo prellenado — el selector sigue editable.
  function handleProductKeyChange(itemId: string, key: string) {
    const tratamiento = sugerencias?.tratamientoPorClave?.[key];
    setItems((prev) =>
      prev.map((it) =>
        it.id === itemId
          ? { ...it, product_key: key, ...(tratamiento ? { iva: tratamiento } : {}) }
          : it
      )
    );
  }

  // ── Calculations ──────────────────────────────────────────────────────────

  const subtotal = items.reduce((sum, it) => sum + it.quantity * it.price, 0);
  const ivaTotal = items
    .filter((it) => it.iva === "16")
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

  // Cuerpo compartido de timbrado y prefactura — el borrador que ve el
  // cliente es EXACTAMENTE lo que después se promueve a CFDI.
  function buildPayload() {
    return {
      companyId: activeCompany!.id,
      customerId: selectedCliente!.id,
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
        // Cuenta predial va en la PARTIDA (nodo CuentaPredial del concepto),
        // no dentro del producto.
        cuentaPredial: it.cuentaPredial.trim() || undefined,
        product: {
          description: it.description,
          product_key: it.product_key,
          price: it.price,
          unit_key: it.unit_key,
          tax_included: false,
          // Tasa 0 y Exento llevan SIEMPRE su nodo de IVA (rate 0) — omitir
          // el impuesto por completo (lo que hacía el checkbox anterior) no
          // es ninguna de las dos cosas y deja el CFDI mal clasificado.
          taxes:
            it.iva === "16"
              ? [{ type: "IVA", rate: 0.16, factor: "Tasa", withholding: false }]
              : it.iva === "0"
                ? [{ type: "IVA", rate: 0, factor: "Tasa", withholding: false }]
                : [{ type: "IVA", rate: 0, factor: "Exento", withholding: false }],
        },
      })),
    };
  }

  // Prefactura: crea el BORRADOR en Facturapi (PDF con marca BORRADOR, sin
  // consumir timbre) y lo guarda para timbrar/compartir/enviar después.
  async function handlePrefactura() {
    if (!activeCompany || !selectedCliente) return;
    setSavingPref(true);
    setSubmitError("");
    try {
      const res = await fetch("/api/facturas/borradores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.needsReconfigure) setNeedsReconfigure(true);
        throw new Error(typeof data.error === "string" ? data.error : "Error al guardar la prefactura");
      }
      setPrefOk({ id: data.id, pdfUrl: data.pdfUrl });
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setSavingPref(false);
    }
  }

  async function handleStamp() {
    if (!activeCompany || !selectedCliente) return;
    setSubmitting(true);
    setSubmitError("");
    // Llave de idempotencia: una nueva por intento de envío. El botón
    // deshabilitado evita el doble clic; la llave evita que UN clic se procese
    // dos veces en el servidor (no se timbra un segundo CFDI ni se consume
    // otro timbre si el request se duplica en la red).
    const idempotencyKey = crypto.randomUUID();
    try {
      const payload = buildPayload();

      const res = await fetch("/api/facturas", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
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

  if (prefOk) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[60vh]">
        <div className="text-center max-w-md w-full">
          <div className="h-16 w-16 rounded-full bg-cos-amber-tint flex items-center justify-center mx-auto mb-4">
            <FileText className="h-8 w-8 text-cos-amber-ink" />
          </div>
          <h2 className="text-xl font-bold mb-2">Prefactura guardada</h2>
          <p className="text-cos-ink-soft text-sm mb-5">
            El PDF sale con marca <b>BORRADOR</b> y no consume timbre. Compártela con tu cliente
            para que valide los datos; cuando esté de acuerdo, tímbrala desde Facturas.
          </p>
          <div className="flex gap-2 justify-center mb-4">
            <a href={prefOk.pdfUrl} target="_blank" rel="noopener noreferrer"
              className="border border-cos-line px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-paper">Ver PDF</a>
            <button
              onClick={() => { navigator.clipboard.writeText(prefOk.pdfUrl); setPrefMailMsg("✓ Enlace copiado (vigente 7 días)"); }}
              className="border border-cos-line px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-paper">
              Copiar enlace
            </button>
          </div>
          <div className="flex gap-2 mb-2">
            <input
              type="email"
              value={prefMail}
              onChange={(e) => setPrefMail(e.target.value)}
              placeholder="correo@cliente.com (vacío = correo del cliente)"
              className="flex-1 border border-cos-line rounded-md px-3 py-2 text-sm"
            />
            <button
              disabled={prefMailBusy}
              onClick={async () => {
                setPrefMailBusy(true);
                setPrefMailMsg("");
                try {
                  const res = await fetch(`/api/facturas/borradores/${prefOk.id}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ accion: "enviar", ...(prefMail.trim() ? { email: prefMail.trim() } : {}) }),
                  });
                  const data = await res.json().catch(() => null);
                  setPrefMailMsg(res.ok ? `✓ Enviada a ${data.email}` : (data?.error ?? "No se pudo enviar"));
                } finally {
                  setPrefMailBusy(false);
                }
              }}
              className="bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50">
              {prefMailBusy ? "Enviando…" : "Enviar por correo"}
            </button>
          </div>
          {prefMailMsg && <p className="text-sm text-cos-ink-soft mb-3">{prefMailMsg}</p>}
          <button
            onClick={() => router.push("/facturas")}
            className="bg-cos-jade-ink text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90">
            Ir a Facturas
          </button>
        </div>
      </div>
    );
  }

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

      <div className="bg-cos-card border border-cos-line rounded-xl shadow-sm">

        {/* ── STEP 1: Receptor ── */}
        {step === 1 && (
          <div className="p-6 space-y-5">
            {/* «Vuelve a facturar»: lo que esta empresa repite mes con mes. Va
                ANTES de elegir cliente porque así se piensa al facturar — «toca
                la renta de Ana», no «veamos qué le facturé a Ana». */}
            {!selectedCliente && (sugerencias?.recurrentes?.length ?? 0) > 0 && (
              <div>
                <h2 className="font-semibold text-base border-b border-cos-line pb-3">
                  Vuelve a facturar
                </h2>
                <p className="mt-2 text-xs text-cos-ink-soft">
                  Lo que facturas de forma recurrente. Un clic llena cliente y conceptos con los
                  datos de la última vez; puedes ajustar todo antes de timbrar.
                </p>
                <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  {sugerencias!.recurrentes!.map((r) => (
                    <button
                      key={r.facturaId}
                      type="button"
                      onClick={() => refacturar(r)}
                      className="text-left rounded-xl border border-cos-line bg-cos-card p-3 hover:border-cos-brand hover:bg-cos-paper transition-colors"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-cos-ink truncate">{r.cliente}</p>
                        <span className="shrink-0 rounded-full bg-cos-slate-tint px-2 py-0.5 text-[11px] font-medium text-cos-ink-soft">
                          {r.veces}×
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-cos-ink-soft truncate">
                        {r.items.map((it) => it.descripcion).join(" · ")}
                      </p>
                      <p className="mt-1 text-sm font-semibold text-cos-ink">
                        {formatCurrency(r.total)}
                        <span className="ml-2 text-[11px] font-normal text-cos-ink-faint">
                          última: {new Date(r.ultimoUso).toLocaleDateString("es-MX", { day: "2-digit", month: "short", year: "numeric" })}
                        </span>
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}

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
                  className="w-full pl-9 pr-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
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

              {/* Usar factura anterior — prefill conceptos from a past invoice */}
              {selectedCliente && sugerencias && sugerencias.facturasPrevias.length > 0 && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setShowFacturasPrevias((v) => !v)}
                    className="flex items-center gap-2 text-sm text-cos-brand-ink hover:text-cos-brand-ink/80 font-medium"
                  >
                    <History className="h-4 w-4" />
                    Usar factura anterior
                    <ChevronRight className={`h-4 w-4 transition-transform ${showFacturasPrevias ? "rotate-90" : ""}`} />
                  </button>
                  {showFacturasPrevias && (
                    <div className="mt-2 border border-cos-line rounded-md overflow-hidden divide-y divide-cos-line">
                      {sugerencias.facturasPrevias.map((f) => (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => prefillFromFactura(f)}
                          className="w-full text-left px-4 py-2.5 hover:bg-cos-paper text-sm transition-colors flex items-center justify-between gap-3"
                        >
                          <div>
                            <p className="font-medium">
                              {f.folio ? `Folio ${f.folio}` : "Factura"}
                              <span className="text-cos-ink-soft font-normal ml-2">
                                {new Date(f.fecha).toLocaleDateString("es-MX", { year: "numeric", month: "short", day: "numeric" })}
                              </span>
                            </p>
                            <p className="text-xs text-cos-ink-soft">
                              {f.items.length} concepto{f.items.length === 1 ? "" : "s"}
                              {f.items[0] ? ` · ${f.items[0].descripcion}` : ""}
                            </p>
                          </div>
                          <span className="text-sm font-medium shrink-0"><Money value={f.total} /></span>
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="text-xs text-cos-ink-soft mt-1.5">
                    Copia los conceptos de una factura previa. Podrás editarlos en el siguiente paso.
                  </p>
                </div>
              )}
            </div>

            {/* Forma + Método de pago */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1.5">Forma de pago <span className="text-cos-red-ink">*</span></label>
                <select value={formaPago} onChange={(e) => setFormaPago(e.target.value)}
                  className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30 bg-cos-card">
                  {FORMAS_PAGO.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Método de pago <span className="text-cos-red-ink">*</span></label>
                <select value={metodoPago} onChange={(e) => setMetodoPago(e.target.value)}
                  className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30 bg-cos-card">
                  {METODOS_PAGO.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
            </div>

            {/* Uso CFDI */}
            <div>
              <label className="block text-sm font-medium mb-1.5">Uso del CFDI <span className="text-cos-red-ink">*</span></label>
              <select value={usoCfdi} onChange={(e) => setUsoCfdi(e.target.value)}
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30 bg-cos-card">
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
                      className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30 bg-cos-card">
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
                      className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30 bg-cos-card">
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
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
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

                  {/* Description — with concepto autocomplete from past invoices */}
                  <div className="relative">
                    <label className="block text-xs font-medium mb-1">Descripción <span className="text-cos-red-ink">*</span></label>
                    <input type="text" value={item.description}
                      onChange={(e) => { updateItem(item.id, "description", e.target.value); setConceptoOpenFor(item.id); }}
                      onFocus={() => setConceptoOpenFor(item.id)}
                      onBlur={() => setTimeout(() => setConceptoOpenFor((cur) => (cur === item.id ? null : cur)), 150)}
                      placeholder="Descripción del producto o servicio"
                      autoComplete="off"
                      className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
                    />
                    {conceptoOpenFor === item.id && (() => {
                      const q = item.description.trim().toLowerCase();
                      const matches = (sugerencias?.conceptos ?? []).filter(
                        (c) => !q || c.descripcion.toLowerCase().includes(q) || c.claveProdServ.includes(q)
                      ).slice(0, 8);
                      if (matches.length === 0) return null;
                      return (
                        <div className="absolute z-20 left-0 right-0 mt-1 bg-cos-card border border-cos-line rounded-md shadow-lg max-h-56 overflow-y-auto divide-y divide-cos-line">
                          <div className="px-3 py-1.5 text-xs text-cos-ink-soft flex items-center gap-1.5 bg-cos-slate-tint">
                            <Sparkles className="h-3 w-3" /> Conceptos sugeridos
                          </div>
                          {matches.map((c) => (
                            <button
                              key={`${c.claveProdServ}-${c.descripcion}`}
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => applyConcepto(item.id, c)}
                              className="w-full text-left px-3 py-2 hover:bg-cos-paper text-sm transition-colors flex items-center justify-between gap-3"
                            >
                              <div className="min-w-0">
                                <p className="font-medium truncate">{c.descripcion}</p>
                                <p className="text-xs text-cos-ink-soft font-mono">
                                  {c.claveProdServ} · {c.claveUnidad} · {c.vecesUsado}×
                                </p>
                              </div>
                              <span className="text-sm shrink-0">{formatCurrency(c.valorUnitario)}</span>
                            </button>
                          ))}
                        </div>
                      );
                    })()}
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
                          onChange={(key) => handleProductKeyChange(item.id, key)}
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
                        className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium mb-1">Precio unitario</label>
                      <input type="number" min="0.01" step="0.01" value={item.price}
                        onChange={(e) => updateItem(item.id, "price", parseFloat(e.target.value) || 0)}
                        className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
                      />
                    </div>
                    <div className="flex flex-col justify-end">
                      <label className="block text-xs font-medium mb-1">IVA</label>
                      <select value={item.iva}
                        onChange={(e) => updateItem(item.id, "iva", e.target.value)}
                        className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30 bg-transparent"
                      >
                        <option value="16">IVA 16%</option>
                        <option value="0">IVA 0% (tasa cero)</option>
                        <option value="EXENTO">Exento</option>
                      </select>
                      {item.iva === "EXENTO" && (
                        <p className="text-xs text-cos-amber-ink mt-1">
                          Exento hace que el IVA de tus gastos NO sea acreditable. Si vendes
                          agua, alimentos o medicinas, lo usual es <b>IVA 0% (tasa cero)</b>.
                          Verifícalo con tu contador.
                        </p>
                      )}
                      {/* Pista por clave SAT — solo informativa, nunca bloquea ni
                          cambia la selección (ver src/lib/fiscal/iva-esperado.ts). */}
                      {(() => {
                        const esperado = contradiccionIva(item.product_key, item.iva);
                        if (!esperado) return null;
                        return (
                          <p className="text-xs text-cos-amber-ink mt-1">
                            Este producto ({esperado.etiqueta}) suele ser{" "}
                            <b>IVA 0% (tasa cero)</b> — {esperado.fundamento}.
                            Verifícalo con tu contador.
                          </p>
                        );
                      })()}
                      <p className="text-xs text-cos-ink-soft mt-1">
                        Importe: <span className="font-medium"><Money value={item.quantity * item.price} /></span>
                      </p>
                    </div>
                  </div>

                  {/* Cuenta predial — sólo aparece cuando el concepto es de
                      arrendamiento de inmuebles (o cuando ya trae una, para
                      poder corregirla). No es un complemento: es el nodo
                      CuentaPredial del propio concepto en CFDI 4.0. */}
                  {(esClaveArrendamiento(item.product_key) || item.cuentaPredial) && (
                    <div className="mt-3">
                      <label className="block text-xs font-medium mb-1">
                        Cuenta predial del inmueble
                        <span className="ml-1 font-normal text-cos-ink-soft">(opcional)</span>
                      </label>
                      <input
                        value={item.cuentaPredial}
                        onChange={(e) => updateItem(item.id, "cuentaPredial", e.target.value)}
                        placeholder="Número de cuenta catastral"
                        maxLength={MAX_LARGO_CUENTA_PREDIAL}
                        className="w-full max-w-[320px] px-3 py-2 border border-cos-line rounded-md font-mono text-sm focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
                      />
                      {(() => {
                        const aviso = avisoCuentaPredial(item.product_key, item.cuentaPredial);
                        return aviso ? (
                          <p className="text-xs text-cos-amber-ink mt-1">{aviso}</p>
                        ) : (
                          <p className="text-xs text-cos-ink-soft mt-1">
                            Se guarda con el concepto: la próxima renta ya viene con ella.
                          </p>
                        );
                      })()}
                    </div>
                  )}
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
                <span>Subtotal</span><span><Money value={subtotal} /></span>
              </div>
              <div className="flex justify-between text-cos-ink-soft">
                <span>IVA 16%</span><span><Money value={ivaTotal} /></span>
              </div>
              <div className="flex justify-between font-semibold text-base pt-1 border-t border-cos-line">
                <span>Total</span><span><Money value={total} /></span>
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
                          <p className="text-xs text-cos-ink-soft">{it.product_key} · {it.unit_key}{it.iva === "16" ? " · IVA 16%" : it.iva === "0" ? " · IVA 0% (tasa cero)" : " · Exento"}</p>
                        </td>
                        <td className="px-4 py-2.5 text-right">{it.quantity}</td>
                        <td className="px-4 py-2.5 text-right"><Money value={it.price} /></td>
                        <td className="px-4 py-2.5 text-right font-medium"><Money value={it.quantity * it.price} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="bg-cos-slate-tint rounded-lg p-4 text-sm space-y-1.5">
                <div className="flex justify-between text-cos-ink-soft">
                  <span>Subtotal</span><span><Money value={subtotal} /></span>
                </div>
                <div className="flex justify-between text-cos-ink-soft">
                  <span>IVA 16%</span><span><Money value={ivaTotal} /></span>
                </div>
                <div className="flex justify-between font-bold text-lg pt-1.5 border-t border-cos-line">
                  <span>Total</span><span><Money value={total} /></span>
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
            <div className="flex items-center gap-2">
              <button onClick={handlePrefactura} disabled={savingPref || submitting}
                title="Guarda un BORRADOR (sin timbre) para compartirlo con el cliente y timbrarlo después"
                className="flex items-center gap-2 border border-cos-line px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-paper disabled:opacity-50">
                {savingPref ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                {savingPref ? "Guardando…" : "Guardar prefactura"}
              </button>
              <button onClick={handleStamp} disabled={submitting || savingPref}
                className="flex items-center gap-2 bg-cos-jade-ink text-white px-5 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                {submitting ? "Timbrando..." : "Timbrar CFDI"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
