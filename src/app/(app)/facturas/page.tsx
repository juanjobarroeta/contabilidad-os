"use client";

import { useEffect, useState, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  FileText, Plus, Download, XCircle, Loader2,
  AlertCircle, X, FileCode2, Archive, ChevronRight, Tag,
} from "lucide-react";
import { classifyEgreso } from "@/lib/contabilidad/classify-egreso";

interface Invoice {
  id: string;
  uuid: string | null;
  fecha: string;
  tipo: "INGRESO" | "EGRESO" | "NOMINA" | "PAGO" | "TRASLADO";
  status: string;
  serie: string | null;
  folio: string | null;
  moneda: string;
  total: number;
  subtotal: number;
  totalImpuestos: number;
  formaPago: string;
  metodoPago: string;
  usoCfdi: string;
  notas: string | null;
  facturapiId: string | null;
  overrideCuenta: string | null;
  customer: { razonSocial: string; rfc: string } | null;
  items: {
    id: string;
    descripcion: string;
    cantidad: number;
    valorUnitario: number;
    importe: number;
    claveProdServ: string;
    claveUnidad: string;
  }[];
}

const TIPO_LABEL: Record<string, string> = {
  INGRESO:  "Ingreso",
  EGRESO:   "Egreso",
  NOMINA:   "Nómina",
  PAGO:     "Pago (REP)",
  TRASLADO: "Traslado",
};
const TIPO_COLOR: Record<string, string> = {
  INGRESO:  "bg-green-100 text-green-700",
  EGRESO:   "bg-red-100 text-red-700",
  NOMINA:   "bg-indigo-100 text-indigo-700",
  PAGO:     "bg-blue-100 text-blue-700",
  TRASLADO: "bg-amber-100 text-amber-700",
};

type TipoFilter = "all" | "INGRESO" | "EGRESO" | "NOMINA" | "PAGO" | "CANCELLED";

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Borrador",
  STAMPED: "Timbrada",
  CANCELLED: "Cancelada",
};
const STATUS_COLOR: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  STAMPED: "bg-green-100 text-green-700",
  CANCELLED: "bg-red-100 text-red-600",
};

function DownloadButton({
  invoiceId,
  format,
  label,
  icon,
}: {
  invoiceId: string;
  format: "pdf" | "xml" | "zip";
  label: string;
  icon: React.ReactNode;
}) {
  const [loading, setLoading] = useState(false);

  async function handleDownload() {
    setLoading(true);
    try {
      const res = await fetch(`/api/facturas/${invoiceId}/download?format=${format}`);
      if (!res.ok) throw new Error("Error al descargar");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `factura.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert("Error al descargar el archivo");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={handleDownload}
      disabled={loading}
      className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm hover:bg-accent transition-colors text-left disabled:opacity-50"
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin shrink-0" /> : icon}
      {label}
    </button>
  );
}

export default function FacturasPage() {
  const { activeCompany } = useCompany();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");
  const [detailInvoice, setDetailInvoice] = useState<Invoice | null>(null);
  const [tipoFilter, setTipoFilter] = useState<TipoFilter>("all");

  const fetchInvoices = useCallback(async () => {
    if (!activeCompany) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/facturas?companyId=${activeCompany.id}`);
      const data = await res.json();
      setInvoices(data);
    } finally {
      setLoading(false);
    }
  }, [activeCompany]);

  useEffect(() => { fetchInvoices(); }, [fetchInvoices]);

  async function handleCancel() {
    if (!cancelId) return;
    setCancelling(true);
    setCancelError("");
    try {
      const res = await fetch(`/api/facturas/${cancelId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Error al cancelar");
      }
      setCancelId(null);
      setDetailInvoice(null);
      fetchInvoices();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setCancelling(false);
    }
  }

  // Filter.
  // "CANCELLED" is a status-level filter (any tipo); all other filters are
  // tipo-level and EXCLUDE cancelled by default so the main tabs show
  // only fiscally valid CFDIs (matches how SAT's own export behaves).
  const filtered =
    tipoFilter === "CANCELLED"
      ? invoices.filter((i) => i.status === "CANCELLED")
      : tipoFilter === "all"
        ? invoices.filter((i) => i.status !== "CANCELLED")
        : invoices.filter((i) => i.tipo === tipoFilter && i.status !== "CANCELLED");

  // Totals summary (across filtered)
  const stamped = filtered.filter((i) => i.status === "STAMPED");
  const totalMes = stamped.reduce((s, i) => s + i.total, 0);
  const ivaTotal = stamped.reduce((s, i) => s + i.totalImpuestos, 0);

  // Counts per tipo (always from non-cancelled full set)
  const tipoCounts = invoices.reduce(
    (acc, i) => {
      if (i.status !== "CANCELLED") acc[i.tipo] = (acc[i.tipo] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );
  const cancelledCount = invoices.filter((i) => i.status === "CANCELLED").length;

  if (!activeCompany) {
    return (
      <div className="p-8 text-muted-foreground text-sm">
        Selecciona una empresa para ver sus facturas.
      </div>
    );
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Facturas (CFDI)</h1>
          <p className="text-muted-foreground text-sm mt-0.5">{activeCompany.razonSocial}</p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`/api/facturas/export?companyId=${activeCompany.id}${tipoFilter !== "all" ? `&tipo=${tipoFilter}` : ""}`}
            title="Descargar todas las facturas filtradas en Excel (CSV UTF-8)"
            className="flex items-center gap-2 border border-border px-4 py-2 rounded-md text-sm font-medium hover:bg-accent transition-colors"
          >
            <Download className="h-4 w-4" />
            Descargar Excel
          </a>
          <a
            href="/facturas/nueva"
            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Nueva factura
          </a>
        </div>
      </div>

      {/* Summary cards */}
      {stamped.length > 0 && (
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="bg-white border border-border rounded-xl p-4 shadow-sm">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Facturas timbradas</p>
            <p className="text-2xl font-bold">{stamped.length}</p>
          </div>
          <div className="bg-white border border-border rounded-xl p-4 shadow-sm">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Total facturado</p>
            <p className="text-2xl font-bold">{formatCurrency(totalMes)}</p>
          </div>
          <div className="bg-white border border-border rounded-xl p-4 shadow-sm">
            <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">IVA cobrado</p>
            <p className="text-2xl font-bold">{formatCurrency(ivaTotal)}</p>
          </div>
        </div>
      )}

      {/* Tipo filter pills */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {([
          ["all",       "Todos",        invoices.length - cancelledCount, "default"],
          ["INGRESO",   "Ingresos",     tipoCounts.INGRESO ?? 0,           "default"],
          ["EGRESO",    "Egresos",      tipoCounts.EGRESO ?? 0,            "default"],
          ["NOMINA",    "Nómina",       tipoCounts.NOMINA ?? 0,            "default"],
          ["PAGO",      "Pagos (REP)",  tipoCounts.PAGO ?? 0,              "default"],
          ["CANCELLED", "Canceladas",   cancelledCount,                    "danger"],
        ] as const).map(([f, label, count, tone]) => {
          const active = tipoFilter === f;
          const dangerTone = tone === "danger";
          const baseCls = active
            ? dangerTone
              ? "bg-red-600 text-white"
              : "bg-primary text-primary-foreground"
            : dangerTone
              ? "bg-red-50 text-red-700 hover:bg-red-100"
              : "bg-gray-100 text-gray-600 hover:bg-gray-200";
          return (
            <button
              key={f}
              onClick={() => setTipoFilter(f)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${baseCls}`}
            >
              {label}{count > 0 ? ` (${count})` : ""}
            </button>
          );
        })}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-border overflow-hidden shadow-sm">
        {loading ? (
          <div className="p-8 flex items-center justify-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando facturas...
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="font-medium">No hay facturas aún</p>
            <p className="text-muted-foreground text-sm mt-1">Emite tu primera factura CFDI 4.0</p>
            <a
              href="/facturas/nueva"
              className="mt-4 inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" /> Nueva factura
            </a>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Tipo</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground hidden lg:table-cell">UUID / Folio</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Contraparte</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Fecha</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground hidden md:table-cell">Pago</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground hidden md:table-cell">Subtotal</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Total</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Estado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((inv) => {
                const isCancelled = inv.status === "CANCELLED";
                return (
                  <tr
                    key={inv.id}
                    className={`border-b border-border last:border-0 transition-colors cursor-pointer ${
                      isCancelled
                        ? "bg-red-50/40 text-muted-foreground hover:bg-red-50"
                        : "hover:bg-gray-50"
                    }`}
                    onClick={() => setDetailInvoice(inv)}
                  >
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${TIPO_COLOR[inv.tipo] ?? "bg-gray-100 text-gray-600"}`}>
                        {TIPO_LABEL[inv.tipo] ?? inv.tipo}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground hidden lg:table-cell">
                      {inv.folio ? `${inv.serie ?? ""}${inv.folio}` : inv.uuid ? inv.uuid.substring(0, 8) + "…" : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <p className={`font-medium truncate max-w-[280px] ${isCancelled ? "line-through" : ""}`}>{inv.customer?.razonSocial ?? "—"}</p>
                      <p className="text-xs text-muted-foreground">{inv.customer?.rfc ?? ""}</p>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">{formatDate(inv.fecha)}</td>
                    <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell">
                      <span>{inv.formaPago}</span>
                      <span className="ml-1 bg-gray-100 px-1.5 py-0.5 rounded text-xs">{inv.metodoPago}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-muted-foreground hidden md:table-cell">{formatCurrency(inv.subtotal)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${isCancelled ? "line-through" : ""}`}>{formatCurrency(inv.total)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[inv.status] ?? "bg-gray-100 text-gray-600"}`}>
                        {STATUS_LABEL[inv.status] ?? inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <ChevronRight className="h-4 w-4 text-muted-foreground ml-auto" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Detail Drawer ── */}
      {detailInvoice && (
        <div className="fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="flex-1 bg-black/40"
            onClick={() => setDetailInvoice(null)}
          />
          {/* Panel */}
          <div className="w-full max-w-md bg-white shadow-2xl flex flex-col overflow-y-auto">
            {/* Drawer header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold text-base">{TIPO_LABEL[detailInvoice.tipo] ?? "Factura"}</h2>
                <p className="text-xs text-muted-foreground font-mono mt-0.5 truncate">
                  {detailInvoice.uuid ?? "Sin UUID"}
                </p>
              </div>
              <button
                onClick={() => setDetailInvoice(null)}
                className="p-1.5 rounded hover:bg-accent text-muted-foreground shrink-0"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="p-5 flex flex-col gap-5">
              {/* Tipo + Status badges */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${TIPO_COLOR[detailInvoice.tipo] ?? "bg-gray-100 text-gray-600"}`}>
                  {TIPO_LABEL[detailInvoice.tipo] ?? detailInvoice.tipo}
                </span>
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_COLOR[detailInvoice.status] ?? "bg-gray-100 text-gray-600"}`}>
                  {STATUS_LABEL[detailInvoice.status] ?? detailInvoice.status}
                </span>
                {detailInvoice.usoCfdi === "CN01" && (
                  <span className="px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                    Recibo de nómina
                  </span>
                )}
              </div>

              {/* Counterparty */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">
                  {detailInvoice.tipo === "EGRESO" || detailInvoice.tipo === "PAGO" ? "Proveedor" :
                   detailInvoice.tipo === "NOMINA" ? "Empleado" : "Cliente / Receptor"}
                </p>
                <p className="font-medium">{detailInvoice.customer?.razonSocial ?? "—"}</p>
                <p className="text-sm text-muted-foreground font-mono">{detailInvoice.customer?.rfc ?? ""}</p>
              </div>

              {/* Fields grid */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Fecha</p>
                  <p className="font-medium">{formatDate(detailInvoice.fecha)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Folio / Serie</p>
                  <p className="font-medium font-mono">
                    {detailInvoice.folio ? `${detailInvoice.serie ?? ""}${detailInvoice.folio}` : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Forma de pago</p>
                  <p className="font-medium">{detailInvoice.formaPago}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Método de pago</p>
                  <p className="font-medium">{detailInvoice.metodoPago}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Uso CFDI</p>
                  <p className="font-medium">{detailInvoice.usoCfdi}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Moneda</p>
                  <p className="font-medium">{detailInvoice.moneda}</p>
                </div>
              </div>

              {/* UUID full */}
              <div>
                <p className="text-xs text-muted-foreground mb-1">UUID</p>
                <p className="font-mono text-xs break-all bg-gray-50 border border-border rounded p-2">
                  {detailInvoice.uuid ?? "—"}
                </p>
              </div>

              {/* Classification override (only for EGRESOs — ingresos always go to 401.x) */}
              {detailInvoice.tipo === "EGRESO" && (
                <ClassificationOverride
                  invoice={detailInvoice}
                  onUpdated={(updated) => {
                    setDetailInvoice((d) => d && d.id === updated.id ? { ...d, overrideCuenta: updated.overrideCuenta } : d);
                    // Also update the list entry so the badge updates without a refetch
                    setInvoices((list) =>
                      list.map((i) => (i.id === updated.id ? { ...i, overrideCuenta: updated.overrideCuenta } : i))
                    );
                  }}
                />
              )}

              {/* Conceptos */}
              {detailInvoice.items.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Conceptos</p>
                  <div className="border border-border rounded-lg overflow-hidden">
                    {detailInvoice.items.map((item, i) => {
                      const classification = detailInvoice.tipo === "EGRESO"
                        ? classifyEgreso(item.claveProdServ)
                        : null;
                      return (
                        <div
                          key={item.id}
                          className={`px-3 py-2.5 text-sm ${i < detailInvoice.items.length - 1 ? "border-b border-border" : ""}`}
                        >
                          <p className="font-medium">{item.descripcion}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {item.cantidad} × {formatCurrency(item.valorUnitario)}
                            <span className="ml-2 font-medium text-foreground">{formatCurrency(item.importe)}</span>
                          </p>
                          <p className="text-xs text-muted-foreground font-mono mt-0.5">
                            {item.claveProdServ} · {item.claveUnidad}
                          </p>
                          {classification && (
                            <div className="mt-1.5 inline-flex items-center gap-1 text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded">
                              <Tag className="h-3 w-3" />
                              <span className="font-mono">{classification.cuenta}</span>
                              <span>· {classification.label}</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {detailInvoice.tipo === "EGRESO" && detailInvoice.items.length > 0 && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Clasificación sugerida por clave del SAT. Se aplica en el cierre mensual.
                    </p>
                  )}
                </div>
              )}

              {/* Totals */}
              <div className="border border-border rounded-lg p-3 text-sm space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{formatCurrency(detailInvoice.subtotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">IVA</span>
                  <span>{formatCurrency(detailInvoice.totalImpuestos)}</span>
                </div>
                <div className="flex justify-between font-semibold border-t border-border pt-1.5">
                  <span>Total</span>
                  <span>{formatCurrency(detailInvoice.total)}</span>
                </div>
              </div>

              {/* Notes */}
              {detailInvoice.notas && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Notas</p>
                  <p className="text-sm">{detailInvoice.notas}</p>
                </div>
              )}

              {/* Downloads */}
              {detailInvoice.status === "STAMPED" && detailInvoice.facturapiId && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Descargas</p>
                  <div className="border border-border rounded-lg overflow-hidden divide-y divide-border">
                    <DownloadButton
                      invoiceId={detailInvoice.id}
                      format="pdf"
                      label="Descargar PDF"
                      icon={<Download className="h-4 w-4 text-red-500 shrink-0" />}
                    />
                    <DownloadButton
                      invoiceId={detailInvoice.id}
                      format="xml"
                      label="Descargar XML"
                      icon={<FileCode2 className="h-4 w-4 text-blue-500 shrink-0" />}
                    />
                    <DownloadButton
                      invoiceId={detailInvoice.id}
                      format="zip"
                      label="Descargar ZIP (PDF + XML)"
                      icon={<Archive className="h-4 w-4 text-purple-500 shrink-0" />}
                    />
                  </div>
                </div>
              )}

              {/* Cancel */}
              {detailInvoice.status === "STAMPED" && (
                <button
                  onClick={() => { setCancelId(detailInvoice.id); setCancelError(""); }}
                  className="flex items-center gap-2 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 px-3 py-2 rounded-md transition-colors w-full"
                >
                  <XCircle className="h-4 w-4" />
                  Cancelar CFDI
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Cancel Confirm Modal ── */}
      {cancelId && (
        <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                  <AlertCircle className="h-5 w-5 text-red-600" />
                </div>
                <h2 className="text-base font-semibold">¿Cancelar CFDI?</h2>
              </div>
              <button onClick={() => setCancelId(null)} className="p-1.5 rounded hover:bg-accent text-muted-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Se enviará la solicitud de cancelación al SAT a través de Facturapi. Esta acción no se puede deshacer fácilmente.
            </p>
            {cancelError && (
              <div className="bg-red-50 border border-red-200 rounded-md px-3 py-2 text-sm text-red-700 mb-4">
                {cancelError}
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="flex-1 flex items-center justify-center gap-2 bg-red-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {cancelling && <Loader2 className="h-4 w-4 animate-spin" />}
                Cancelar CFDI
              </button>
              <button
                onClick={() => setCancelId(null)}
                className="flex-1 px-4 py-2 rounded-md text-sm border border-border hover:bg-accent"
              >
                Mantener
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Classification override (small inline editor) ──────────────────────────
function ClassificationOverride({
  invoice,
  onUpdated,
}: {
  invoice: Invoice;
  onUpdated: (updated: { id: string; overrideCuenta: string | null }) => void;
}) {
  // Current effective classification (auto from first item, or manual override)
  const auto = invoice.items[0]
    ? classifyEgreso(invoice.items[0].claveProdServ)
    : { cuenta: "601.99", label: "Otros gastos" };
  const effective = invoice.overrideCuenta ?? auto.cuenta;
  const isOverridden = !!invoice.overrideCuenta;

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(effective);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/facturas/${invoice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrideCuenta: value.trim() || null }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error ?? "Error");
      }
      const updated = await res.json();
      onUpdated({ id: updated.id, overrideCuenta: updated.overrideCuenta });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setSaving(false);
    }
  }

  async function clearOverride() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/facturas/${invoice.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrideCuenta: null }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      onUpdated({ id: updated.id, overrideCuenta: updated.overrideCuenta });
      setValue(auto.cuenta);
      setEditing(false);
    } catch {
      setError("Error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-border rounded-lg p-3 bg-gray-50/50">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Clasificación contable
        </p>
        {!editing && (
          <button
            onClick={() => { setEditing(true); setValue(effective); }}
            className="text-xs text-primary hover:underline"
          >
            Editar
          </button>
        )}
      </div>

      {!editing ? (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm">{effective}</span>
          <span className="text-xs text-muted-foreground">· {isOverridden ? "manual" : auto.label}</span>
          {isOverridden && (
            <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">
              override
            </span>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="601.15"
            autoFocus
            className="w-full px-2 py-1 border border-border rounded text-sm font-mono"
          />
          <p className="text-[10px] text-muted-foreground">
            Código SAT de la subcuenta (ej. <code>601.02</code> Honorarios, <code>601.15</code> Combustibles).
            Debe existir en tu catálogo.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={save}
              disabled={saving || !value.trim()}
              className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded font-medium disabled:opacity-50 flex items-center gap-1"
            >
              {saving && <Loader2 className="h-3 w-3 animate-spin" />}
              Guardar
            </button>
            {isOverridden && (
              <button
                onClick={clearOverride}
                disabled={saving}
                className="text-xs border border-border px-3 py-1.5 rounded font-medium"
              >
                Usar automática
              </button>
            )}
            <button
              onClick={() => { setEditing(false); setValue(effective); setError(""); }}
              disabled={saving}
              className="text-xs text-muted-foreground px-2 py-1.5"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
