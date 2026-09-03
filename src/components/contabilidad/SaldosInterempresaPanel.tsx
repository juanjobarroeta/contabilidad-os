"use client";

import { useEffect, useState } from "react";
import { Money } from "@/components/ui";
import { formatCurrency } from "@/lib/utils";
import { Loader2, ArrowLeftRight } from "lucide-react";

export interface SaldoRow {
  companyId: string;
  rfc: string;
  razonSocial: string;
  prestamosOtorgados: number;
  prestamosPorPagar: number;
  neto: number;
}

export function SaldosInterempresaPanel({ companyId }: { companyId: string }) {
  const [rows, setRows] = useState<SaldoRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/contabilidad/saldos-interempresa?companyId=${companyId}`);
        const data = await res.json();
        setRows(data.rows ?? []);
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    })();
  }, [companyId]);

  const totalOtorgados = rows.reduce((s, r) => s + r.prestamosOtorgados, 0);
  const totalPorPagar = rows.reduce((s, r) => s + r.prestamosPorPagar, 0);
  const hasActivity = rows.some((r) => Math.abs(r.neto) > 0.01);

  return (
    <div>
      <p className="text-xs text-cos-ink-soft mb-4">
        Posición neta de préstamos entre todas las empresas del despacho.
        Saldo positivo = prestamista neto, negativo = deudor neto.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-cos-ink-soft py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : !hasActivity ? (
        <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-12 text-center">
          <ArrowLeftRight className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
          <p className="text-sm text-cos-ink-soft">Sin préstamos interempresa registrados.</p>
          <p className="text-xs text-cos-ink-soft mt-1">
            Los préstamos aparecen cuando clasificas transacciones bancarias como
            &ldquo;Préstamo otorgado&rdquo; o &ldquo;Préstamo recibido&rdquo; y cierras el mes.
          </p>
        </div>
      ) : (
        <div className="bg-cos-card border border-cos-line rounded-xl overflow-hidden">
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cos-line bg-cos-paper">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Empresa</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">RFC</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Otorgados</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Por pagar</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Neto</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.companyId} className="border-b border-cos-line last:border-0 hover:bg-cos-paper/50">
                  <td className="px-4 py-2.5 font-medium">{r.razonSocial}</td>
                  <td className="px-4 py-2.5 text-xs font-mono text-cos-ink-soft">{r.rfc}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">
                    {r.prestamosOtorgados > 0 ? formatCurrency(r.prestamosOtorgados) : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs">
                    {r.prestamosPorPagar > 0 ? formatCurrency(r.prestamosPorPagar) : "—"}
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono text-xs font-semibold ${
                    r.neto > 0 ? "text-cos-jade-ink" : r.neto < 0 ? "text-cos-red-ink" : ""
                  }`}>
                    {Math.abs(r.neto) < 0.01 ? "—" : formatCurrency(r.neto)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-cos-paper font-semibold">
                <td className="px-4 py-2.5" colSpan={2}>Total despacho</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs"><Money value={totalOtorgados} /></td>
                <td className="px-4 py-2.5 text-right font-mono text-xs"><Money value={totalPorPagar} /></td>
                <td className="px-4 py-2.5 text-right font-mono text-xs font-bold">
                  <Money value={totalOtorgados - totalPorPagar} />
                </td>
              </tr>
            </tfoot>
          </table></div>
        </div>
      )}
    </div>
  );
}
