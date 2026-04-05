"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  ChevronLeft, ChevronRight, Calculator, Save,
  CheckCircle2, AlertCircle, Loader2, FileText,
  TrendingUp, TrendingDown, Info, RefreshCw, ArrowUpRight, ArrowDownLeft,
} from "lucide-react";

const MONTHS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

// ── API response shape ────────────────────────────────────────────────────────
interface IvaRaw {
  trasladado: number;
  retenidoPorClientes: number;
  acreditable: number;
}
interface IsrRaw {
  ingresos: number;
  gastos: number;
}
interface FacturaRow {
  id: string;
  uuid: string | null;
  tipo: "INGRESO" | "EGRESO";
  fecha: string;
  contraparte: string;
  rfc: string;
  subtotal: number;
  iva: number;
  total: number;
}
interface DeclaracionResult {
  periodo: string;
  month: number;
  year: number;
  iva: IvaRaw;
  isr: IsrRaw;
  facturas: FacturaRow[];
  declaracionGuardada: {
    id: string;
    status: string;
    saldoFavorAnterior: number;
    coeficienteUtilidad: number;
  } | null;
}

// ── Status helpers ────────────────────────────────────────────────────────────
const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Borrador",
  CALCULATED: "Calculada",
  FILED: "Presentada",
  PAID: "Pagada",
};
const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  CALCULATED: "bg-blue-100 text-blue-700",
  FILED: "bg-yellow-100 text-yellow-700",
  PAID: "bg-green-100 text-green-700",
};

// ── Small helpers ─────────────────────────────────────────────────────────────
function Row({ label, value, bold, accent, children }: {
  label: string; value?: string; bold?: boolean;
  accent?: "green" | "red" | "blue" | "purple";
  children?: React.ReactNode;
}) {
  const valueClass =
    accent === "green" ? "text-green-700 font-semibold" :
    accent === "red"   ? "text-red-700 font-semibold" :
    accent === "blue"  ? "text-blue-700 font-semibold" :
    accent === "purple"? "text-purple-700 font-semibold" :
    bold               ? "font-semibold" :
                         "text-muted-foreground";

  return (
    <div className={`flex justify-between items-center py-1.5 ${bold ? "border-t border-border mt-1 pt-2.5" : ""}`}>
      <span className={`text-sm ${bold ? "font-medium" : "text-muted-foreground"}`}>{label}</span>
      {children ?? <span className={`text-sm ${valueClass}`}>{value}</span>}
    </div>
  );
}

function CurrencyInput({ value, onChange, placeholder }: {
  value: number; onChange: (v: number) => void; placeholder?: string;
}) {
  const [raw, setRaw] = useState(value === 0 ? "" : String(value));

  // sync when parent resets (e.g. after loading saved declaration)
  useEffect(() => {
    setRaw(value === 0 ? "" : String(value));
  }, [value]);

  return (
    <input
      type="number"
      min="0"
      step="0.01"
      value={raw}
      placeholder={placeholder ?? "0.00"}
      onChange={(e) => {
        setRaw(e.target.value);
        const n = parseFloat(e.target.value);
        onChange(isNaN(n) ? 0 : n);
      }}
      className="w-32 text-right text-sm border border-border rounded-md px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary bg-white"
    />
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ImpuestosPage() {
  const { activeCompany } = useCompany();

  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<DeclaracionResult | null>(null);
  const [error, setError] = useState("");
  const [savedStatus, setSavedStatus] = useState<string | null>(null);

  // User-adjustable inputs
  const [saldoFavorAnterior, setSaldoFavorAnterior] = useState(0);
  const [coeficienteUtilidad, setCoeficienteUtilidad] = useState(0);

  // Invoice table filter
  const [facturaFilter, setFacturaFilter] = useState<"all" | "INGRESO" | "EGRESO">("all");

  // SAT sync state
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string>("");
  const [syncDone, setSyncDone] = useState(false);

  // ── Derived IVA ─────────────────────────────────────────────────────────────
  const ivaComputed = useMemo(() => {
    if (!result) return null;
    const { trasladado, retenidoPorClientes, acreditable } = result.iva;
    const cargo = trasladado - retenidoPorClientes - acreditable - saldoFavorAnterior;
    return {
      trasladado,
      retenidoPorClientes,
      acreditable,
      saldoFavorAnterior,
      pagar: cargo > 0 ? cargo : 0,
      saldoFavor: cargo < 0 ? Math.abs(cargo) : 0,
    };
  }, [result, saldoFavorAnterior]);

  // ── Derived ISR ─────────────────────────────────────────────────────────────
  const isrComputed = useMemo(() => {
    if (!result) return null;
    const { ingresos, gastos } = result.isr;
    const tasa = 0.30;
    let baseGravable: number;
    let modoCalculo: "coeficiente" | "directo";

    if (coeficienteUtilidad > 0) {
      // ISR provisional = ingresos del período × coeficiente × tasa 30%
      baseGravable = ingresos * coeficienteUtilidad;
      modoCalculo = "coeficiente";
    } else {
      // Fallback: (ingresos − gastos) × tasa 30%
      baseGravable = Math.max(0, ingresos - gastos);
      modoCalculo = "directo";
    }

    return {
      ingresos,
      gastos,
      coeficienteUtilidad,
      baseGravable,
      tasa,
      estimado: baseGravable * tasa,
      modoCalculo,
    };
  }, [result, coeficienteUtilidad]);

  // ── Fetch ────────────────────────────────────────────────────────────────────
  const calcular = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/impuestos?companyId=${activeCompany.id}&month=${month}&year=${year}`
      );
      if (!res.ok) throw new Error("Error al calcular");
      const data: DeclaracionResult = await res.json();
      setResult(data);
      setSavedStatus(data.declaracionGuardada?.status ?? null);
      // Restore saved adjustment values
      setSaldoFavorAnterior(data.declaracionGuardada?.saldoFavorAnterior ?? 0);
      setCoeficienteUtilidad(data.declaracionGuardada?.coeficienteUtilidad ?? 0);
    } catch {
      setError("No se pudo calcular la declaración");
    } finally {
      setLoading(false);
    }
  }, [activeCompany, month, year]);

  useEffect(() => { calcular(); }, [calcular]);

  // ── Navigation ───────────────────────────────────────────────────────────────
  function prevMonth() {
    if (month === 1) { setMonth(12); setYear((y) => y - 1); }
    else setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (month === 12) { setMonth(1); setYear((y) => y + 1); }
    else setMonth((m) => m + 1);
  }

  // ── Save ─────────────────────────────────────────────────────────────────────
  async function handleGuardar(status: "CALCULATED" | "FILED") {
    if (!activeCompany || !result || !ivaComputed || !isrComputed) return;
    setSaving(true);
    try {
      const res = await fetch("/api/impuestos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: activeCompany.id,
          periodo: result.periodo,
          tipo: "IVA_MENSUAL",
          ivaData: {
            trasladado: ivaComputed.trasladado,
            acreditable: ivaComputed.acreditable,
            saldoFavor: ivaComputed.saldoFavor,
            pagar: ivaComputed.pagar,
          },
          isrData: {
            ingresos: isrComputed.ingresos,
            gastos: isrComputed.gastos,
            baseGravable: isrComputed.baseGravable,
            tasa: isrComputed.tasa,
            estimado: isrComputed.estimado,
          },
          saldoFavorAnterior,
          coeficienteUtilidad,
          status,
        }),
      });
      if (!res.ok) throw new Error("Error al guardar");
      const saved = await res.json();
      setSavedStatus(saved.status);
    } catch {
      setError("No se pudo guardar la declaración");
    } finally {
      setSaving(false);
    }
  }

  // ── SAT sync ──────────────────────────────────────────────────────────────────
  async function handleSatSync() {
    if (!activeCompany) return;
    setSyncing(true);
    setSyncDone(false);
    setSyncStatus("Autenticando con el SAT...");
    setError("");

    try {
      const reqRes = await fetch("/api/sat/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, month, year }),
      });
      const reqData = await reqRes.json();
      if (!reqRes.ok) throw new Error(reqData.error ?? `Error ${reqRes.status} al solicitar CFDIs al SAT`);

      const { emitidosRequestId, recibidosRequestId } = reqData;
      setSyncStatus("Solicitud enviada al SAT. Esperando paquetes (emitidos + recibidos)...");

      let attempts = 0;
      const maxAttempts = 24;

      const poll = async (): Promise<void> => {
        if (attempts >= maxAttempts) {
          setSyncStatus("El SAT está tardando más de lo esperado. Intenta de nuevo en unos minutos.");
          setSyncing(false);
          return;
        }
        attempts++;

        const verRes = await fetch("/api/sat/sync/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            companyId: activeCompany.id,
            emitidosRequestId,
            recibidosRequestId,
            month,
            year,
          }),
        });
        const verData = await verRes.json();

        if (verData.status === "pending") {
          setSyncStatus(verData.message ?? "Preparando paquetes...");
          await new Promise((r) => setTimeout(r, 5000));
          return poll();
        }
        if (verData.status === "empty") {
          setSyncStatus("No se encontraron CFDIs del SAT en este período.");
          setSyncDone(true);
          setSyncing(false);
          return;
        }
        if (verData.status === "done" || verData.status === "partial") {
          setSyncStatus(verData.message ?? "¡Sincronización completada!");
          setSyncDone(true);
          setSyncing(false);
          calcular();
          return;
        }
        throw new Error(verData.message ?? verData.error ?? "Error en sincronización");
      };

      await poll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al sincronizar con el SAT");
      setSyncing(false);
    }
  }

  // ── Filtered invoice rows ─────────────────────────────────────────────────────
  const filteredFacturas = useMemo(() => {
    if (!result) return [];
    if (facturaFilter === "all") return result.facturas;
    return result.facturas.filter((f) => f.tipo === facturaFilter);
  }, [result, facturaFilter]);

  // ── Guard ─────────────────────────────────────────────────────────────────────
  if (!activeCompany) {
    return (
      <div className="p-8 text-muted-foreground text-sm">
        Selecciona una empresa para ver sus declaraciones.
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Declaraciones Fiscales</h1>
        <p className="text-muted-foreground text-sm mt-0.5">{activeCompany.razonSocial}</p>
      </div>

      {/* Period selector */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={prevMonth} className="p-1.5 rounded-md border border-border hover:bg-accent transition-colors">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-lg font-semibold min-w-[160px] text-center">
          {MONTHS[month - 1]} {year}
        </span>
        <button onClick={nextMonth} className="p-1.5 rounded-md border border-border hover:bg-accent transition-colors">
          <ChevronRight className="h-4 w-4" />
        </button>
        {savedStatus && (
          <span className={`ml-3 px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[savedStatus] ?? "bg-gray-100 text-gray-600"}`}>
            {STATUS_LABELS[savedStatus] ?? savedStatus}
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 mb-4">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-12 justify-center">
          <Loader2 className="h-5 w-5 animate-spin" />
          Calculando declaración...
        </div>
      ) : result && ivaComputed && isrComputed ? (
        <div className="space-y-5">

          {/* ── IVA Card ── */}
          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-blue-100 flex items-center justify-center">
                  <Calculator className="h-4 w-4 text-blue-600" />
                </div>
                <div>
                  <h2 className="font-semibold text-sm">IVA Mensual</h2>
                  <p className="text-xs text-muted-foreground">Período {result.periodo}</p>
                </div>
              </div>
              {ivaComputed.pagar > 0 ? (
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">A pagar</p>
                  <p className="text-lg font-bold text-red-600">{formatCurrency(ivaComputed.pagar)}</p>
                </div>
              ) : ivaComputed.saldoFavor > 0 ? (
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Saldo a favor</p>
                  <p className="text-lg font-bold text-green-600">{formatCurrency(ivaComputed.saldoFavor)}</p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Sin movimiento</p>
              )}
            </div>
            <div className="px-5 py-4">
              <Row label="IVA trasladado cobrado a clientes" value={formatCurrency(ivaComputed.trasladado)} />
              {ivaComputed.retenidoPorClientes > 0 && (
                <Row label="IVA retenido por clientes" value={`(${formatCurrency(ivaComputed.retenidoPorClientes)})`} />
              )}
              <Row label="IVA acreditable (facturas de proveedores)" value={formatCurrency(ivaComputed.acreditable)} />
              {/* Saldo a favor anterior — editable inline */}
              <Row label="Saldo a favor de meses anteriores">
                <CurrencyInput
                  value={saldoFavorAnterior}
                  onChange={setSaldoFavorAnterior}
                  placeholder="0.00"
                />
              </Row>
              <Row
                label={ivaComputed.pagar > 0 ? "IVA a cargo" : "Saldo a favor este mes"}
                value={formatCurrency(ivaComputed.pagar > 0 ? ivaComputed.pagar : ivaComputed.saldoFavor)}
                bold
                accent={ivaComputed.pagar > 0 ? "red" : "green"}
              />
            </div>
            {ivaComputed.acreditable === 0 && (
              <div className="px-5 pb-4">
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>El IVA acreditable se calculará automáticamente cuando importes facturas de proveedores desde el SAT (recibidos).</span>
                </div>
              </div>
            )}
          </div>

          {/* ── ISR Card ── */}
          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="h-8 w-8 rounded-lg bg-purple-100 flex items-center justify-center">
                  <TrendingUp className="h-4 w-4 text-purple-600" />
                </div>
                <div>
                  <h2 className="font-semibold text-sm">ISR Provisional</h2>
                  <p className="text-xs text-muted-foreground">
                    {isrComputed.modoCalculo === "coeficiente"
                      ? `Coeficiente de utilidad ${(isrComputed.coeficienteUtilidad * 100).toFixed(4)}%`
                      : "Estimado — ingresos − gastos × 30%"}
                  </p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Estimado a pagar</p>
                <p className="text-lg font-bold text-purple-700">{formatCurrency(isrComputed.estimado)}</p>
              </div>
            </div>
            <div className="px-5 py-4">
              <Row label="Ingresos del período" value={formatCurrency(isrComputed.ingresos)} accent="blue" />
              {isrComputed.modoCalculo === "coeficiente" ? (
                <>
                  <Row label={`× Coeficiente de utilidad`}>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.0001"
                        value={coeficienteUtilidad === 0 ? "" : coeficienteUtilidad}
                        placeholder="0.0000"
                        onChange={(e) => {
                          const n = parseFloat(e.target.value);
                          setCoeficienteUtilidad(isNaN(n) ? 0 : Math.min(1, Math.max(0, n)));
                        }}
                        className="w-24 text-right text-sm border border-border rounded-md px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-primary bg-white"
                      />
                    </div>
                  </Row>
                  <Row label="Utilidad fiscal estimada" value={formatCurrency(isrComputed.baseGravable)} bold />
                </>
              ) : (
                <>
                  <Row label="Deducciones (gastos facturados)" value={formatCurrency(isrComputed.gastos)} />
                  <Row label="Base gravable" value={formatCurrency(isrComputed.baseGravable)} bold />
                </>
              )}
              <Row label="Tasa ISR (30%)" value={formatCurrency(isrComputed.estimado)} bold accent="purple" />

              {/* Coeficiente toggle/input when in direct mode */}
              {isrComputed.modoCalculo === "directo" && (
                <div className="mt-3 flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">¿Tienes coeficiente de utilidad?</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.0001"
                      value={coeficienteUtilidad === 0 ? "" : coeficienteUtilidad}
                      placeholder="ej. 0.3520"
                      onChange={(e) => {
                        const n = parseFloat(e.target.value);
                        setCoeficienteUtilidad(isNaN(n) ? 0 : Math.min(1, Math.max(0, n)));
                      }}
                      className="w-28 text-sm border border-border rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary bg-white"
                    />
                  </div>
                </div>
              )}
            </div>
            <div className="px-5 pb-4">
              <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  {isrComputed.modoCalculo === "coeficiente"
                    ? "Cálculo basado en tu coeficiente de utilidad del ejercicio anterior (Art. 14 LISR). El ISR definitivo puede variar según ajuste anual."
                    : "Sin coeficiente de utilidad: se usa ingresos − gastos. Ingresa tu coeficiente asignado por el SAT para mayor precisión."}
                </span>
              </div>
            </div>
          </div>

          {/* ── Facturas del período ── */}
          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2 flex-wrap">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-semibold text-sm">
                Facturas de {MONTHS[month - 1]} {year}
              </h2>
              <span className="ml-auto text-xs text-muted-foreground">{result.facturas.length} factura(s)</span>
              {/* Filter tabs */}
              <div className="flex gap-1 ml-3">
                {(["all", "INGRESO", "EGRESO"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFacturaFilter(f)}
                    className={`px-2.5 py-0.5 rounded-full text-xs font-medium transition-colors ${
                      facturaFilter === f
                        ? "bg-primary text-primary-foreground"
                        : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                    }`}
                  >
                    {f === "all" ? "Todas" : f === "INGRESO" ? "Emitidas" : "Recibidas"}
                  </button>
                ))}
              </div>
            </div>

            {filteredFacturas.length > 0 ? (
              <>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-gray-50">
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground w-20">Tipo</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Fecha</th>
                      <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Contraparte</th>
                      <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Subtotal</th>
                      <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">IVA</th>
                      <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredFacturas.map((f) => (
                      <tr key={f.id} className="border-b border-border last:border-0 hover:bg-gray-50/50">
                        <td className="px-4 py-2.5">
                          {f.tipo === "INGRESO" ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-green-50 text-green-700">
                              <ArrowUpRight className="h-3 w-3" />
                              Emitida
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium bg-orange-50 text-orange-700">
                              <ArrowDownLeft className="h-3 w-3" />
                              Recibida
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatDate(f.fecha)}</td>
                        <td className="px-4 py-2.5">
                          <p className="font-medium text-xs">{f.contraparte}</p>
                          <p className="text-xs text-muted-foreground">{f.rfc}</p>
                        </td>
                        <td className="px-4 py-2.5 text-right text-xs">{formatCurrency(f.subtotal)}</td>
                        <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{formatCurrency(f.iva)}</td>
                        <td className={`px-4 py-2.5 text-right text-xs font-semibold ${f.tipo === "INGRESO" ? "text-green-700" : "text-orange-700"}`}>
                          {f.tipo === "EGRESO" ? "(" : ""}{formatCurrency(f.total)}{f.tipo === "EGRESO" ? ")" : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="bg-gray-50 border-t border-border">
                      <td colSpan={3} className="px-4 py-2.5 text-xs font-semibold">Totales ({filteredFacturas.length})</td>
                      <td className="px-4 py-2.5 text-right text-xs font-semibold">
                        {formatCurrency(filteredFacturas.reduce((s, f) => s + f.subtotal, 0))}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs font-semibold">
                        {formatCurrency(filteredFacturas.reduce((s, f) => s + f.iva, 0))}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs font-semibold">
                        {formatCurrency(filteredFacturas.reduce((s, f) => s + f.total, 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </>
            ) : (
              <div className="p-10 text-center">
                <TrendingDown className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-30" />
                <p className="font-medium text-sm">Sin facturas en este período</p>
                <p className="text-xs text-muted-foreground mt-1">No hay CFDIs en {MONTHS[month - 1]} {year}</p>
              </div>
            )}
          </div>

          {/* ── SAT Sync ── */}
          <div className="bg-white rounded-xl border border-border shadow-sm p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold text-sm">Sincronizar CFDIs del SAT</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Descarga tus facturas emitidas y recibidas directamente del SAT usando tu e.firma (FIEL).
                </p>
              </div>
              <button
                onClick={handleSatSync}
                disabled={syncing}
                className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors shrink-0"
              >
                {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {syncing ? "Sincronizando..." : "Sincronizar CFDIs"}
              </button>
            </div>

            {(syncing || syncStatus) && (
              <div className={`mt-3 flex items-center gap-2 text-xs px-3 py-2 rounded-md ${
                syncDone
                  ? "bg-green-50 text-green-700 border border-green-200"
                  : syncing
                  ? "bg-blue-50 text-blue-700 border border-blue-200"
                  : "bg-gray-50 text-muted-foreground border border-border"
              }`}>
                {syncing && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
                {syncDone && <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
                {syncStatus}
              </div>
            )}
          </div>

          {/* ── Actions ── */}
          <div className="flex items-center gap-3 pb-2">
            <button
              onClick={() => handleGuardar("CALCULATED")}
              disabled={saving}
              className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Guardar declaración
            </button>
            <button
              onClick={() => handleGuardar("FILED")}
              disabled={saving}
              className="flex items-center gap-2 border border-border px-4 py-2 rounded-md text-sm font-medium hover:bg-accent disabled:opacity-50 transition-colors"
            >
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Marcar como presentada
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
