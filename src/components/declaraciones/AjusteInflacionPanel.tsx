"use client";

import { useCallback, useEffect, useState } from "react";
import { Money } from "@/components/ui";
import { AlertCircle, Calculator, ChevronDown, ChevronRight, Loader2 } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Panel del ajuste anual por inflación (Arts. 44-46 LISR).
//
// La cifra sale del ledger, no de una captura. Pero los Arts. 45 y 46 excluyen
// partidas por HECHOS que el catálogo no conoce —si un deudor diverso es un
// socio, si un cobro anticipado es en numerario—, así que el panel muestra el
// detalle cuenta por cuenta con su fundamento y deja reclasificar antes de
// llevar el resultado a la declaración. Se propone; el contador confirma.
// ─────────────────────────────────────────────────────────────────────────────

type Clase = "CREDITO" | "DEUDA" | "EXCLUIDA";

type CuentaAjuste = {
  clave: string;
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  clase: Clase;
  fundamento: string;
  revisar: boolean;
  sobreescrita: boolean;
  promedio: number;
  saldosMensuales: number[];
};

type Resultado = {
  year: number;
  factorAjuste: {
    factor: number | null;
    inpcFinal: number | null;
    inpcBase: number | null;
    mesFinal: { year: number; month: number };
    mesBase: { year: number; month: number };
  };
  promedioCreditos: number;
  promedioDeudas: number;
  diferencia: number;
  acumulable: number;
  deducible: number;
  cuentas: CuentaAjuste[];
  advertencias: string[];
  calculable: boolean;
};

const ETIQUETA: Record<Clase, string> = {
  CREDITO: "Crédito (Art. 45)",
  DEUDA: "Deuda (Art. 46)",
  EXCLUIDA: "Excluida",
};

export function AjusteInflacionPanel({
  companyId,
  ejercicio,
  onAplicar,
}: {
  companyId: string;
  ejercicio: number;
  onAplicar: (acumulable: number, deducible: number) => void;
}) {
  const [data, setData] = useState<Resultado | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [abierto, setAbierto] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, Clase>>({});

  const cargar = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ companyId, ejercicio: String(ejercicio) });
      if (Object.keys(overrides).length > 0) params.set("overrides", JSON.stringify(overrides));
      const res = await fetch(`/api/fiscal/ajuste-inflacion?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Error");
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, [companyId, ejercicio, overrides]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  function reclasificar(clave: string, clase: Clase) {
    setOverrides((prev) => ({ ...prev, [clave]: clase }));
  }

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 rounded-card border border-cos-line bg-cos-card p-4 text-xs text-cos-ink-soft">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Calculando el ajuste por inflación desde el ledger…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-card border border-cos-line bg-cos-card p-4 text-xs text-cos-ink-soft">
        No se pudo calcular el ajuste por inflación: {error}
      </div>
    );
  }
  if (!data) return null;

  const esAcumulable = data.acumulable > 0;
  const monto = esAcumulable ? data.acumulable : data.deducible;

  return (
    <div className="rounded-card border border-cos-line bg-cos-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-cos-line p-4">
        <div>
          <h3 className="text-sm font-semibold text-cos-ink">Ajuste anual por inflación</h3>
          <p className="mt-0.5 text-[11px] text-cos-ink-soft">
            Arts. 44 a 46 LISR · calculado con los saldos mensuales del ledger, no capturado a mano
          </p>
        </div>
        {data.calculable && (
          <button
            onClick={() => onAplicar(data.acumulable, data.deducible)}
            className="flex items-center gap-2 rounded-control bg-cos-brand-ink px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            <Calculator className="h-3.5 w-3.5" /> Usar en la declaración
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 p-4 sm:grid-cols-4">
        <Dato label="Promedio de créditos" value={data.promedioCreditos} />
        <Dato label="Promedio de deudas" value={data.promedioDeudas} />
        <div>
          <p className="text-[10px] uppercase tracking-wide text-cos-ink-soft">Factor de ajuste</p>
          <p className="font-mono text-sm text-cos-ink">
            {data.factorAjuste.factor != null ? `${(data.factorAjuste.factor * 100).toFixed(4)} %` : "—"}
          </p>
          <p className="text-[10px] text-cos-ink-soft">
            INPC {mes(data.factorAjuste.mesFinal)} ÷ {mes(data.factorAjuste.mesBase)}
          </p>
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-cos-ink-soft">
            {esAcumulable ? "Acumulable (ingreso)" : data.deducible > 0 ? "Deducible" : "Sin ajuste"}
          </p>
          <p className={`font-mono text-sm font-semibold ${esAcumulable ? "text-cos-ink" : "text-cos-jade-ink"}`}>
            <Money value={monto} />
          </p>
          <p className="text-[10px] text-cos-ink-soft">
            {esAcumulable ? "Art. 44 frac. II" : data.deducible > 0 ? "Art. 44 frac. III" : "créditos = deudas"}
          </p>
        </div>
      </div>

      {data.advertencias.length > 0 && (
        <div className="border-t border-cos-line px-4 py-3">
          {data.advertencias.map((a) => (
            <p key={a} className="flex items-start gap-1.5 text-[11px] text-cos-amber-ink">
              <AlertCircle className="mt-px h-3 w-3 shrink-0" />
              {a}
            </p>
          ))}
        </div>
      )}

      <button
        onClick={() => setAbierto(!abierto)}
        className="flex w-full items-center gap-1.5 border-t border-cos-line px-4 py-2.5 text-left text-xs text-cos-brand-ink hover:bg-cos-surface"
      >
        {abierto ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Detalle por cuenta ({data.cuentas.length}) — reclasificar créditos y deudas
      </button>

      {abierto && (
        <div className="overflow-x-auto border-t border-cos-line">
          <table className="w-full min-w-[720px] text-xs">
            <thead>
              <tr className="border-b border-cos-line text-left text-[10px] uppercase tracking-wide text-cos-ink-soft">
                <th className="px-4 py-2 font-medium">Cuenta</th>
                <th className="px-4 py-2 text-right font-medium">Saldo promedio anual</th>
                <th className="px-4 py-2 font-medium">Clasificación</th>
                <th className="px-4 py-2 font-medium">Fundamento</th>
              </tr>
            </thead>
            <tbody>
              {data.cuentas.map((c) => (
                <tr key={c.clave} className="border-b border-cos-line/60 last:border-0">
                  <td className="px-4 py-2">
                    <span className="font-mono text-cos-ink-soft">{c.clave}</span>{" "}
                    <span className="text-cos-ink">{c.nombre}</span>
                    {c.revisar && c.clase !== "EXCLUIDA" && (
                      <span className="ml-1.5 rounded-full bg-cos-amber-tint px-1.5 py-px text-[9px] font-medium text-cos-amber-ink">
                        revisar
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    <Money value={c.promedio} />
                  </td>
                  <td className="px-4 py-2">
                    <select
                      value={c.clase}
                      onChange={(e) => reclasificar(c.clave, e.target.value as Clase)}
                      className={`rounded-control border px-1.5 py-1 text-[11px] ${
                        c.sobreescrita ? "border-cos-brand-ink/40 bg-cos-brand-tint" : "border-cos-line bg-cos-card"
                      }`}
                    >
                      {(Object.keys(ETIQUETA) as Clase[]).map((k) => (
                        <option key={k} value={k}>
                          {ETIQUETA[k]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2 text-[11px] text-cos-ink-soft">{c.fundamento}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Dato({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wide text-cos-ink-soft">{label}</p>
      <p className="font-mono text-sm text-cos-ink">
        <Money value={value} />
      </p>
    </div>
  );
}

function mes(m: { year: number; month: number }): string {
  return `${m.year}-${String(m.month).padStart(2, "0")}`;
}
