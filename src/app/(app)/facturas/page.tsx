"use client";

import { useEffect, useState, useCallback } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  FileText, Plus, Download, XCircle, Loader2,
  AlertCircle, X,
} from "lucide-react";

interface Invoice {
  id: string;
  uuid: string | null;
  fecha: string;
  tipo: string;
  status: string;
  total: number;
  subtotal: number;
  totalImpuestos: number;
  formaPago: string;
  metodoPago: string;
  pdfUrl: string | null;
  xmlUrl: string | null;
  customer: { razonSocial: string; rfc: string } | null;
}

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

export default function FacturasPage() {
  const { activeCompany } = useCompany();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");

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
      fetchInvoices();
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Error inesperado");
    } finally {
      setCancelling(false);
    }
  }

  // Totals summary
  const stamped = invoices.filter((i) => i.status === "STAMPED");
  const totalMes = stamped.reduce((s, i) => s + i.total, 0);
  const ivaTotal = stamped.reduce((s, i) => s + i.totalImpuestos, 0);

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
        <a href="/facturas/nueva"
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors">
          <Plus className="h-4 w-4" />
          Nueva factura
        </a>
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

      {/* Table */}
      <div className="bg-white rounded-xl border border-border overflow-hidden shadow-sm">
        {loading ? (
          <div className="p-8 flex items-center justify-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Cargando facturas...
          </div>
        ) : invoices.length === 0 ? (
          <div className="p-12 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="font-medium">No hay facturas aún</p>
            <p className="text-muted-foreground text-sm mt-1">Emite tu primera factura CFDI 4.0</p>
            <a href="/facturas/nueva"
              className="mt-4 inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90">
              <Plus className="h-4 w-4" /> Nueva factura
            </a>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">UUID</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Cliente</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Fecha</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground hidden md:table-cell">Pago</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Subtotal</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Total</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Estado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-border last:border-0 hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {inv.uuid ? inv.uuid.substring(0, 8) + "…" : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{inv.customer?.razonSocial ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">{inv.customer?.rfc ?? ""}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground text-xs">{formatDate(inv.fecha)}</td>
                  <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell">
                    <span>{inv.formaPago}</span>
                    <span className="ml-1 bg-gray-100 px-1.5 py-0.5 rounded text-xs">{inv.metodoPago}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">{formatCurrency(inv.subtotal)}</td>
                  <td className="px-4 py-3 text-right font-semibold">{formatCurrency(inv.total)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[inv.status] ?? "bg-gray-100 text-gray-600"}`}>
                      {STATUS_LABEL[inv.status] ?? inv.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      {inv.status === "STAMPED" && (
                        <>
                          {inv.pdfUrl && (
                            <a href={inv.pdfUrl} target="_blank" rel="noopener noreferrer"
                              title="Descargar PDF"
                              className="p-1.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
                              <Download className="h-3.5 w-3.5" />
                            </a>
                          )}
                          <button
                            title="Cancelar CFDI"
                            onClick={() => { setCancelId(inv.id); setCancelError(""); }}
                            className="p-1.5 rounded hover:bg-red-50 text-muted-foreground hover:text-red-600">
                            <XCircle className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Cancel Confirm Modal ── */}
      {cancelId && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
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
              <button onClick={handleCancel} disabled={cancelling}
                className="flex-1 flex items-center justify-center gap-2 bg-red-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-red-700 disabled:opacity-50">
                {cancelling && <Loader2 className="h-4 w-4 animate-spin" />}
                Cancelar CFDI
              </button>
              <button onClick={() => setCancelId(null)}
                className="flex-1 px-4 py-2 rounded-md text-sm border border-border hover:bg-accent">
                Mantener
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
