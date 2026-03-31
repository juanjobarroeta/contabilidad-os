"use client";

import { useEffect, useState } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { formatCurrency, formatDate } from "@/lib/utils";
import { FileText, Plus, Download, XCircle } from "lucide-react";

interface Invoice {
  id: string;
  uuid: string | null;
  fecha: string;
  tipo: string;
  status: string;
  total: number;
  subtotal: number;
  formaPago: string;
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

  useEffect(() => {
    if (!activeCompany) return;
    setLoading(true);
    fetch(`/api/facturas?companyId=${activeCompany.id}`)
      .then((r) => r.json())
      .then(setInvoices)
      .finally(() => setLoading(false));
  }, [activeCompany]);

  if (!activeCompany) {
    return (
      <div className="p-8 text-muted-foreground text-sm">
        Selecciona una empresa para ver sus facturas.
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Facturas (CFDI)</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            {activeCompany.razonSocial}
          </p>
        </div>
        <a
          href="/facturas/nueva"
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-md text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          Nueva factura
        </a>
      </div>

      <div className="bg-white rounded-xl border border-border overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-muted-foreground text-sm">Cargando facturas...</div>
        ) : invoices.length === 0 ? (
          <div className="p-12 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium">No hay facturas aún</p>
            <p className="text-muted-foreground text-sm mt-1">
              Emite tu primera factura CFDI 4.0
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-gray-50">
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Folio fiscal (UUID)</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Cliente</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Fecha</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Tipo</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Total</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Estado</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-border last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {inv.uuid ? inv.uuid.substring(0, 8) + "..." : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{inv.customer?.razonSocial ?? "—"}</p>
                    <p className="text-xs text-muted-foreground">{inv.customer?.rfc ?? ""}</p>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDate(inv.fecha)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{inv.tipo}</td>
                  <td className="px-4 py-3 text-right font-medium">{formatCurrency(inv.total)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[inv.status] ?? "bg-gray-100 text-gray-600"}`}
                    >
                      {STATUS_LABEL[inv.status] ?? inv.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      {inv.status === "STAMPED" && (
                        <>
                          <button
                            title="Descargar PDF"
                            className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                          <button
                            title="Cancelar"
                            className="p-1.5 rounded hover:bg-accent text-muted-foreground"
                          >
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
    </div>
  );
}
