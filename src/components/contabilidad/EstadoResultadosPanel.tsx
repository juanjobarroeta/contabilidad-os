"use client";

import { useEffect, useState } from "react";
import { Money } from "@/components/ui";
import { Loader2, FileText } from "lucide-react";
import { BotonExcel } from "@/components/contabilidad/BotonExcel";
import { PeriodPicker } from "@/components/contabilidad/PeriodPicker";
import { PreliminarBanner } from "@/components/contabilidad/PreliminarBanner";

export interface EstadoResultadosRow {
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  monto: number;
}
export interface EstadoResultados {
  ingresos: EstadoResultadosRow[];
  costos: EstadoResultadosRow[];
  gastos: EstadoResultadosRow[];
  totalIngresos: number;
  totalCostos: number;
  totalGastos: number;
  utilidadBruta: number;
  utilidadAntesImpuestos: number;
  preliminar?: boolean;
}

export function EstadoResultadosPanel({
  companyId, year, month, onChangePeriod,
}: { companyId: string; year: number; month: number; onChangePeriod: (y: number, m: number) => void }) {
  const [data, setData] = useState<EstadoResultados | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch(
        `/api/contabilidad/estado-resultados?companyId=${companyId}&year=${year}&month=${month}`
      );
      const d = await res.json();
      setData(d);
      setLoading(false);
    })();
  }, [companyId, year, month]);

  return (
    <div>
      <PeriodPicker year={year} month={month} onChange={onChangePeriod} />

      <div className="mb-3 flex justify-end">
        <BotonExcel
          href={`/api/contabilidad/estado-resultados?companyId=${companyId}&year=${year}&month=${month}&format=xlsx`}
          label="Estado de resultados en Excel"
        />
      </div>

      {!loading && data?.preliminar && (data.ingresos.length > 0 || data.gastos.length > 0 || data.costos.length > 0) && <PreliminarBanner />}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-cos-ink-soft py-8 justify-center">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : !data || (data.ingresos.length === 0 && data.gastos.length === 0 && data.costos.length === 0) ? (
        <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-12 text-center">
          <FileText className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
          <p className="text-sm text-cos-ink-soft">Sin movimientos para este periodo.</p>
        </div>
      ) : (
        <div className="bg-cos-card border border-cos-line rounded-xl p-6 space-y-5 text-sm">
          <Section label="Ingresos" rows={data.ingresos} total={data.totalIngresos} positive />
          {data.costos.length > 0 && (
            <Section label="Costos" rows={data.costos} total={data.totalCostos} positive={false} />
          )}
          <Section label="Gastos" rows={data.gastos} total={data.totalGastos} positive={false} />

          <div className="border-t-2 border-cos-line pt-4 space-y-2">
            {data.costos.length > 0 && (
              <div className="flex items-center justify-between font-medium">
                <span>Utilidad bruta</span>
                <span className={data.utilidadBruta >= 0 ? "text-cos-jade-ink" : "text-cos-red-ink"}>
                  <Money value={data.utilidadBruta} />
                </span>
              </div>
            )}
            <div className="flex items-center justify-between text-base font-bold">
              <span>Utilidad antes de impuestos</span>
              <span className={data.utilidadAntesImpuestos >= 0 ? "text-cos-jade-ink" : "text-cos-red-ink"}>
                <Money value={data.utilidadAntesImpuestos} />
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({
  label, rows, total, positive,
}: {
  label: string;
  rows: EstadoResultadosRow[];
  total: number;
  positive: boolean;
}) {
  return (
    <div>
      <p className="font-semibold text-xs uppercase tracking-wide text-cos-ink-soft mb-2">{label}</p>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={`${r.cuentaSAT}-${r.subcuenta}`} className="flex items-center justify-between text-sm">
            <span className="text-cos-ink-soft">{r.nombre}</span>
            <span className="font-mono"><Money value={r.monto} /></span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between border-t border-cos-line mt-2 pt-2 font-medium">
        <span>Total {label.toLowerCase()}</span>
        <span className={`font-mono ${positive ? "text-cos-jade-ink" : "text-cos-red-ink"}`}>
          <Money value={total} />
        </span>
      </div>
    </div>
  );
}
