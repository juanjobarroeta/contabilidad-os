"use client";

import { useCallback, useEffect, useState } from "react";
import { Money } from "@/components/ui";
import { Alert, Loading, RetryButton } from "@/components/ui/feedback";
import { formatCurrency } from "@/lib/utils";
import { BookOpen } from "lucide-react";
import { AuxiliarCuentaModal } from "@/components/contabilidad/LibroPanels";
import { BotonExcel } from "@/components/contabilidad/BotonExcel";
import { PeriodPicker } from "@/components/contabilidad/PeriodPicker";
import { PreliminarBanner } from "@/components/contabilidad/PreliminarBanner";

export interface BalanzaRow {
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  tipo: "ACTIVO" | "PASIVO" | "CAPITAL" | "INGRESO" | "GASTO" | "COSTO";
  nivel: number;
  cargos: number;
  abonos: number;
  saldo: number;
}

export function BalanzaPanel({
  companyId, year, month, onChangePeriod,
}: { companyId: string; year: number; month: number; onChangePeriod: (y: number, m: number) => void }) {
  // Tri-estado: null = aún no carga, [] = periodo genuinamente vacío.
  const [rows, setRows] = useState<BalanzaRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preliminar, setPreliminar] = useState(false);
  // Drill-down: clic en una cuenta → auxiliar con saldo corrido.
  const [auxCuenta, setAuxCuenta] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/contabilidad/balanza?companyId=${companyId}&year=${year}&month=${month}`
      );
      const data = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(data?.rows)) {
        throw new Error(data?.error ?? "No se pudo cargar la balanza");
      }
      setRows(data.rows);
      setPreliminar(Boolean(data.preliminar));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar la balanza");
    } finally {
      setLoading(false);
    }
  }, [companyId, year, month]);

  useEffect(() => { cargar(); }, [cargar]);

  const nonZero = (rows ?? []).filter(r => Math.abs(r.cargos) > 0.01 || Math.abs(r.abonos) > 0.01);

  return (
    <div>
      {/* Controles de pantalla (período y descarga): fuera del papel. */}
      <div className="print:hidden">
        <PeriodPicker year={year} month={month} onChange={onChangePeriod} />
      </div>

      <div className="mb-3 flex justify-end print:hidden">
        <BotonExcel
          href={`/api/contabilidad/balanza?companyId=${companyId}&year=${year}&month=${month}&format=xlsx`}
          label="Balanza en Excel"
        />
      </div>

      {!loading && !error && preliminar && nonZero.length > 0 && <PreliminarBanner />}

      {error ? (
        <Alert tone="danger" action={<RetryButton onClick={cargar} />}>{error}</Alert>
      ) : loading || rows === null ? (
        <Loading />
      ) : nonZero.length === 0 ? (
        <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-12 text-center">
          <BookOpen className="h-10 w-10 text-cos-ink-soft mx-auto mb-3 opacity-30" />
          <p className="text-sm text-cos-ink-soft">Sin movimientos para este periodo.</p>
          <p className="text-xs text-cos-ink-soft mt-1">Cierra el mes desde la pestaña &ldquo;Cierres mensuales&rdquo;.</p>
        </div>
      ) : (
        <div className="bg-cos-card border border-cos-line rounded-xl overflow-hidden print:overflow-visible">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-cos-line bg-cos-paper">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Cuenta</th>
                <th className="text-left px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Nombre</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Cargos</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Abonos</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-cos-ink-soft">Saldo</th>
              </tr>
            </thead>
            <tbody>
              {nonZero.map((r, i) => (
                <tr
                  key={`${r.cuentaSAT}-${r.subcuenta}-${i}`}
                  onClick={() => setAuxCuenta(r.subcuenta ?? r.cuentaSAT)}
                  title="Ver auxiliar de la cuenta"
                  className="border-b border-cos-line last:border-0 hover:bg-cos-paper/50 cursor-pointer"
                >
                  <td className="px-4 py-2 text-xs font-mono">{r.subcuenta ?? r.cuentaSAT}</td>
                  <td className="px-4 py-2">{r.nombre}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{r.cargos > 0 ? formatCurrency(r.cargos) : "—"}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs">{r.abonos > 0 ? formatCurrency(r.abonos) : "—"}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs font-semibold"><Money value={r.saldo} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {auxCuenta && (
        <AuxiliarCuentaModal
          companyId={companyId}
          year={year}
          month={month}
          cuenta={auxCuenta}
          onClose={() => setAuxCuenta(null)}
        />
      )}
    </div>
  );
}
