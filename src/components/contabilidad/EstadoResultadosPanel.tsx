"use client";

import { useCallback, useEffect, useState } from "react";
import { Money } from "@/components/ui";
import { Alert, Loading, RetryButton } from "@/components/ui/feedback";
import { FileText } from "lucide-react";
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
  // Tri-estado: null = aún no carga; el payload vacío es el vacío genuino.
  const [data, setData] = useState<EstadoResultados | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const cargar = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/contabilidad/estado-resultados?companyId=${companyId}&year=${year}&month=${month}`
      );
      const d = await res.json().catch(() => null);
      // Un objeto de error del API no tiene la forma del estado de resultados:
      // no lo guardamos como si fuera dato.
      if (!res.ok || !Array.isArray(d?.ingresos) || !Array.isArray(d?.gastos) || !Array.isArray(d?.costos)) {
        throw new Error(d?.error ?? "No se pudo cargar el estado de resultados");
      }
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el estado de resultados");
    } finally {
      setLoading(false);
    }
  }, [companyId, year, month]);

  useEffect(() => { cargar(); }, [cargar]);

  return (
    <div>
      {/* Controles de pantalla (período y descarga): fuera del papel. */}
      <div className="print:hidden">
        <PeriodPicker year={year} month={month} onChange={onChangePeriod} />
      </div>

      <div className="mb-3 flex justify-end print:hidden">
        <BotonExcel
          href={`/api/contabilidad/estado-resultados?companyId=${companyId}&year=${year}&month=${month}&format=xlsx`}
          label="Estado de resultados en Excel"
        />
      </div>

      {!loading && !error && data?.preliminar && (data.ingresos.length > 0 || data.gastos.length > 0 || data.costos.length > 0) && <PreliminarBanner />}

      {error ? (
        <Alert tone="danger" action={<RetryButton onClick={cargar} />}>{error}</Alert>
      ) : loading || !data ? (
        <Loading />
      ) : data.ingresos.length === 0 && data.gastos.length === 0 && data.costos.length === 0 ? (
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
