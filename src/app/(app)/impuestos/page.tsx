"use client";

import { useEffect, useState, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  ChevronLeft, ChevronRight, Calculator, Save,
  CheckCircle2, AlertCircle, Loader2, FileText,
  TrendingUp, TrendingDown, Info, RefreshCw,
} from "lucide-react";

const MONTHS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

interface IvaData {
  trasladado: number;
  retenidoPorClientes: number;
  acreditable: number;
  pagar: number;
  saldoFavor: number;
}

interface IsrData {
  ingresos: number;
  gastos: number;
  baseGravable: number;
  tasa: number;
  estimado: number;
}

interface FacturaRow {
  id: string;
  uuid: string | null;
  fecha: string;
  cliente: string;
  rfc: string;
  subtotal: number;
  iva: number;
  total: number;
}

interface DeclaracionResult {
  periodo: string;
  month: number;
  year: number;
  iva: IvaData;
  isr: IsrData;
  facturas: FacturaRow[];
  declaracionGuardada: { id: string; status: string } | null;
}

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

function Row({ label, value, bold, accent }: {
  label: string; value: string; bold?: boolean; accent?: "green" | "red" | "blue";
}) {
  const valueClass = accent === "green"
    ? "text-green-700 font-semibold"
    : accent === "red"
    ? "text-red-700 font-semibold"
    : accent === "blue"
    ? "text-blue-700 font-semibold"
    : bold
    ? "font-semibold"
    : "text-muted-foreground";

  return (
    <div className={`flex justify-between items-center py-1.5 ${bold ? "border-t border-border mt-1 pt-2.5" : ""}`}>
      <span className={`text-sm ${bold ? "font-medium" : "text-muted-foreground"}`}>{label}</span>
      <span className={`text-sm ${valueClass}`}>{value}</span>
    </div>
  );
}

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

  // SAT sync state
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string>("");
  const [syncDone, setSyncDone] = useState(false);

  const calcular = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/impuestos?companyId=${activeCompany.id}&month=${month}&year=${year}`
      );
      if (!res.ok) throw new Error("Error al calcular");
      const data = await res.json();
      setResult(data);
      setSavedStatus(data.declaracionGuardada?.status ?? null);
    } catch {
      setError("No se pudo calcular la declaración");
    } finally {
      setLoading(false);
    }
  }, [activeCompany, month, year]);

  useEffect(() => { calcular(); }, [calcular]);

  function prevMonth() {
    if (month === 1) { setMonth(12); setYear((y) => y - 1); }
    else setMonth((m) => m - 1);
  }
  function nextMonth() {
    if (month === 12) { setMonth(1); setYear((y) => y + 1); }
    else setMonth((m) => m + 1);
  }

  async function handleGuardar(status: "CALCULATED" | "FILED") {
    if (!activeCompany || !result) return;
    setSaving(true);
    try {
      const res = await fetch("/api/impuestos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyId: activeCompany.id,
          periodo: result.periodo,
          tipo: "IVA_MENSUAL",
          ivaData: result.iva,
          isrData: result.isr,
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

  async function handleSatSync() {
    if (!activeCompany) return;
    setSyncing(true);
    setSyncDone(false);
    setSyncStatus("Autenticando con el SAT...");
    setError("");

    try {
      // Step 1: Send both emitidos + recibidos requests in one call
      const reqRes = await fetch("/api/sat/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: activeCompany.id, month, year }),
      });
      const reqData = await reqRes.json();
      if (!reqRes.ok) throw new Error(reqData.error ?? "Error al solicitar CFDIs al SAT");

      const { emitidosRequestId, recibidosRequestId } = reqData;
      setSyncStatus("Solicitud enviada al SAT. Esperando paquetes (emitidos + recibidos)...");

      // Step 2: Poll verify until done
      let attempts = 0;
      const maxAttempts = 24; // ~2 minutes at 5s intervals

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
      ) : result ? (
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
              {result.iva.pagar > 0 ? (
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">A pagar</p>
                  <p className="text-lg font-bold text-red-600">{formatCurrency(result.iva.pagar)}</p>
                </div>
              ) : result.iva.saldoFavor > 0 ? (
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Saldo a favor</p>
                  <p className="text-lg font-bold text-green-600">{formatCurrency(result.iva.saldoFavor)}</p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Sin movimiento</p>
              )}
            </div>
            <div className="px-5 py-4">
              <Row label="IVA trasladado cobrado a clientes" value={formatCurrency(result.iva.trasladado)} />
              {result.iva.retenidoPorClientes > 0 && (
                <Row label="IVA retenido por clientes" value={`(${formatCurrency(result.iva.retenidoPorClientes)})`} />
              )}
              <Row label="IVA acreditable (gastos deducibles)" value={formatCurrency(result.iva.acreditable)} />
              <Row
                label={result.iva.pagar > 0 ? "IVA a cargo" : "Saldo a favor"}
                value={formatCurrency(result.iva.pagar > 0 ? result.iva.pagar : result.iva.saldoFavor)}
                bold
                accent={result.iva.pagar > 0 ? "red" : "green"}
              />
            </div>
            {result.iva.acreditable === 0 && (
              <div className="px-5 pb-4">
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700">
                  <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <span>El IVA acreditable se calculará automáticamente cuando registres facturas de proveedores (egresos).</span>
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
                  <p className="text-xs text-muted-foreground">Estimado — Régimen General 30%</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Estimado a pagar</p>
                <p className="text-lg font-bold text-purple-700">{formatCurrency(result.isr.estimado)}</p>
              </div>
            </div>
            <div className="px-5 py-4">
              <Row
                label="Ingresos del período"
                value={formatCurrency(result.isr.ingresos)}
                accent="blue"
              />
              <Row label="Deducciones (gastos facturados)" value={formatCurrency(result.isr.gastos)} />
              <Row label="Base gravable" value={formatCurrency(result.isr.baseGravable)} bold />
              <Row label={`Tasa ISR (${(result.isr.tasa * 100).toFixed(0)}%)`} value={formatCurrency(result.isr.estimado)} bold accent="blue" />
            </div>
            <div className="px-5 pb-4">
              <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-xs text-blue-700">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>Este es un estimado basado en régimen general (30%). Consulta a tu contador para calcular el ISR exacto según tu régimen y coeficiente de utilidad.</span>
              </div>
            </div>
          </div>

          {/* ── Facturas del período ── */}
          {result.facturas.length > 0 && (
            <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
              <div className="px-5 py-4 border-b border-border flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <h2 className="font-semibold text-sm">
                  Facturas emitidas en {MONTHS[month - 1]} {year}
                </h2>
                <span className="ml-auto text-xs text-muted-foreground">{result.facturas.length} factura(s)</span>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-gray-50">
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Fecha</th>
                    <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Cliente</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Subtotal</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">IVA</th>
                    <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {result.facturas.map((f) => (
                    <tr key={f.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{formatDate(f.fecha)}</td>
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-xs">{f.cliente}</p>
                        <p className="text-xs text-muted-foreground">{f.rfc}</p>
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs">{formatCurrency(f.subtotal)}</td>
                      <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{formatCurrency(f.iva)}</td>
                      <td className="px-4 py-2.5 text-right text-xs font-semibold">{formatCurrency(f.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t border-border">
                    <td colSpan={2} className="px-4 py-2.5 text-xs font-semibold">Totales</td>
                    <td className="px-4 py-2.5 text-right text-xs font-semibold">
                      {formatCurrency(result.facturas.reduce((s, f) => s + f.subtotal, 0))}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs font-semibold">
                      {formatCurrency(result.facturas.reduce((s, f) => s + f.iva, 0))}
                    </td>
                    <td className="px-4 py-2.5 text-right text-xs font-semibold">
                      {formatCurrency(result.facturas.reduce((s, f) => s + f.total, 0))}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {result.facturas.length === 0 && (
            <div className="bg-white rounded-xl border border-border shadow-sm p-10 text-center">
              <TrendingDown className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-30" />
              <p className="font-medium text-sm">Sin facturas en este período</p>
              <p className="text-xs text-muted-foreground mt-1">No hay facturas timbradas en {MONTHS[month - 1]} {year}</p>
            </div>
          )}

          {/* ── SAT Sync ── */}
          <div className="bg-white rounded-xl border border-border shadow-sm p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="font-semibold text-sm">Sincronizar CFDIs del SAT</h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Descarga tus CFDIs directamente del SAT usando tu e.firma (FIEL) para obtener datos exactos de IVA acreditable.
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
