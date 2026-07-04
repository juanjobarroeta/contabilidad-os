"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Validación del cálculo — «Nómina en paralelo».
//
// Recalculamos las últimas quincenas timbradas (importadas del SAT) con
// nuestro motor y las tablas VIGENTES a cada fecha de pago, y mostramos el
// diff por empleado y concepto contra lo que timbró el proveedor actual.
// Coincidir al centavo construye confianza matemática. El tono ante una
// diferencia es NEUTRO: «las cifras difieren de nuestras tablas vigentes —
// revísalo con tu proveedor actual», nunca una acusación.
// Sólo lectura: nada de esta vista escribe en datos de nómina.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { Scale, ChevronDown, ChevronRight, BadgeCheck, AlertTriangle, Info } from "lucide-react";
import { Card } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/utils";

interface ConceptoComparado {
  nuestro: number;
  timbrado: number;
  delta: number;
}

interface ComparacionRecibo {
  comparable: boolean;
  motivoNoComparable?: string;
  isr?: ConceptoComparado;
  imssObrero?: ConceptoComparado;
  subsidio?: ConceptoComparado;
  veredicto: "coincide" | "difiere" | "no-comparable";
}

interface EmpleadoComparacion {
  employeeId: string;
  nombre: string;
  rfc: string;
  comparacion: ComparacionRecibo;
}

interface ComparacionCorrida {
  runId: string;
  periodo: string;
  fechaPago: string;
  empleadosComparados: number;
  coinciden: number;
  difieren: number;
  noComparables: number;
  empleados: EmpleadoComparacion[];
}

interface HallazgoParalelo {
  runId: string;
  periodo: string;
  fechaPago: string;
  empleado: string;
  concepto: string;
  timbrado: number;
  nuestro: number;
  delta: number;
}

interface ResumenParalelo {
  corridas: ComparacionCorrida[];
  global: {
    corridas: number;
    empleadosComparados: number;
    coinciden: number;
    difieren: number;
    noComparables: number;
  };
  motivosNoComparables: Record<string, number>;
  hallazgos: HallazgoParalelo[];
  toleranciaPesos: number;
}

const CONCEPTOS: Array<{ key: "isr" | "imssObrero" | "subsidio"; label: string }> = [
  { key: "isr", label: "ISR retenido" },
  { key: "imssObrero", label: "IMSS obrero" },
  { key: "subsidio", label: "Subsidio al empleo (entregado)" },
];

function periodoLabel(periodo: string): string {
  const [ini, fin] = periodo.split("/");
  if (ini && fin) return `${formatDate(ini)} – ${formatDate(fin)}`;
  return periodo;
}

function deltaLabel(delta: number): string {
  if (delta === 0) return "$0.00";
  return `${delta > 0 ? "+" : "−"}${formatCurrency(Math.abs(delta))}`;
}

export default function ValidacionCalculo({ companyId }: { companyId: string }) {
  const [data, setData] = useState<ResumenParalelo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expandida, setExpandida] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(`/api/nomina/paralelo?companyId=${companyId}&runs=6`);
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  const g = data?.global;

  return (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-cos-brand-tint px-2.5 py-1 text-[13px] font-semibold text-cos-brand-ink">
          <Scale className="h-3.5 w-3.5" /> Validación del cálculo
        </span>
        {g && g.empleadosComparados > 0 && g.difieren === 0 && (
          <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-cos-jade-ink">
            <BadgeCheck className="h-4 w-4" /> Coincidimos al centavo
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-[13.5px] leading-relaxed text-cos-ink-soft">
          Recalculando tus quincenas timbradas con nuestras tablas…
        </p>
      ) : error ? (
        <p className="text-[13.5px] leading-relaxed text-cos-ink-soft">
          No pudimos recalcular tu historial en este momento. Intenta de nuevo más tarde.
        </p>
      ) : !data || data.corridas.length === 0 ? (
        <p className="text-[13.5px] leading-relaxed text-cos-ink-soft">
          Aún no hay quincenas ordinarias timbradas en tu historial del SAT para comparar. En cuanto
          se importen, recalcularemos cada recibo con las tablas vigentes y verás aquí el resultado,
          concepto por concepto.
        </p>
      ) : g && g.empleadosComparados === 0 ? (
        <div className="text-[13.5px] leading-relaxed text-cos-ink-soft">
          <p>
            Recalculamos tus últimas {data.corridas.length} corrida{data.corridas.length === 1 ? "" : "s"},
            pero ningún recibo trae los datos necesarios para una comparación honesta:
          </p>
          <MotivosList motivos={data.motivosNoComparables} />
        </div>
      ) : (
        <>
          <p className="text-[13.5px] leading-relaxed text-cos-ink-soft">
            Recalculamos tus últimas {data.corridas.length} quincena{data.corridas.length === 1 ? "" : "s"} con
            las tablas vigentes a cada fecha de pago:{" "}
            <b className="text-cos-ink">
              coincidimos al centavo en {g!.coinciden} de {g!.empleadosComparados} recibo
              {g!.empleadosComparados === 1 ? "" : "s"}
            </b>
            {g!.noComparables > 0 ? ` (${g!.noComparables} sin datos suficientes para comparar)` : ""}.
          </p>
          {g!.difieren > 0 && (
            <div className="mt-2.5 flex items-start gap-2 rounded-control border border-cos-amber bg-cos-amber-tint px-3.5 py-2.5 text-[13px] leading-relaxed text-cos-amber-ink">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
              <span>
                En {g!.difieren} recibo{g!.difieren === 1 ? "" : "s"} las cifras difieren de nuestras
                tablas vigentes — revísalo con tu proveedor actual. Una diferencia no implica un error:
                puede deberse a criterios de cálculo distintos, pero conviene aclararla.
              </span>
            </div>
          )}

          {/* corridas */}
          <div className="mt-3.5 divide-y divide-cos-line border-t border-cos-line">
            {data.corridas.map((c) => (
              <CorridaRow
                key={c.runId}
                corrida={c}
                abierta={expandida === c.runId}
                onToggle={() => setExpandida(expandida === c.runId ? null : c.runId)}
              />
            ))}
          </div>

          {/* hallazgos: las diferencias más grandes */}
          {data.hallazgos.length > 0 && (
            <div className="mt-4">
              <p className="mb-1.5 text-[13px] font-semibold text-cos-ink">Diferencias más grandes</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-[12.5px]">
                  <thead>
                    <tr className="text-left text-cos-ink-faint">
                      <th className="py-1 pr-3 font-medium">Periodo</th>
                      <th className="py-1 pr-3 font-medium">Empleado</th>
                      <th className="py-1 pr-3 font-medium">Concepto</th>
                      <th className="py-1 pr-3 text-right font-medium">Timbrado</th>
                      <th className="py-1 pr-3 text-right font-medium">Nuestro cálculo</th>
                      <th className="py-1 text-right font-medium">Diferencia</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.hallazgos.slice(0, 5).map((h, i) => (
                      <tr key={`${h.runId}-${h.empleado}-${h.concepto}-${i}`} className="border-t border-cos-line text-cos-ink">
                        <td className="py-1.5 pr-3 whitespace-nowrap">{periodoLabel(h.periodo)}</td>
                        <td className="py-1.5 pr-3">{h.empleado}</td>
                        <td className="py-1.5 pr-3 whitespace-nowrap">{h.concepto}</td>
                        <td className="py-1.5 pr-3 text-right font-mono">{formatCurrency(h.timbrado)}</td>
                        <td className="py-1.5 pr-3 text-right font-mono">{formatCurrency(h.nuestro)}</td>
                        <td className="py-1.5 text-right font-mono font-semibold text-cos-amber-ink">{deltaLabel(h.delta)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {g!.noComparables > 0 && (
            <div className="mt-3.5 text-[12.5px] leading-relaxed text-cos-ink-faint">
              <span className="font-medium text-cos-ink-soft">
                {g!.noComparables} recibo{g!.noComparables === 1 ? "" : "s"} sin comparar:
              </span>
              <MotivosList motivos={data.motivosNoComparables} />
            </div>
          )}

          <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-cos-ink-faint">
            <Info className="mt-0.5 h-3.5 w-3.5 flex-none" />
            <span>
              Comparamos sólo la matemática fiscal (ISR, IMSS obrero y subsidio) tomando como dadas
              las percepciones timbradas. Tolerancia de ±{formatCurrency(data.toleranciaPesos)} por
              concepto: las convenciones de redondeo entre sistemas difieren legítimamente. Este
              análisis es informativo y no modifica tu nómina.
            </span>
          </p>
        </>
      )}
    </Card>
  );
}

function MotivosList({ motivos }: { motivos: Record<string, number> }) {
  const entradas = Object.entries(motivos).sort((a, b) => b[1] - a[1]);
  if (entradas.length === 0) return null;
  return (
    <ul className="mt-1 list-disc space-y-0.5 pl-5">
      {entradas.map(([motivo, n]) => (
        <li key={motivo}>
          {motivo} <span className="text-cos-ink-faint">({n} recibo{n === 1 ? "" : "s"})</span>
        </li>
      ))}
    </ul>
  );
}

function CorridaRow({
  corrida,
  abierta,
  onToggle,
}: {
  corrida: ComparacionCorrida;
  abierta: boolean;
  onToggle: () => void;
}) {
  const comparables = corrida.empleados.filter((e) => e.comparacion.comparable);
  const noComparables = corrida.empleados.filter((e) => !e.comparacion.comparable);

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-cos-brand-tint/40"
        aria-expanded={abierta}
      >
        {abierta ? (
          <ChevronDown className="h-4 w-4 flex-none text-cos-ink-faint" />
        ) : (
          <ChevronRight className="h-4 w-4 flex-none text-cos-ink-faint" />
        )}
        <span className="flex-1 text-[13.5px] text-cos-ink">
          {periodoLabel(corrida.periodo)}
          <span className="text-cos-ink-faint"> · pago {formatDate(corrida.fechaPago)}</span>
        </span>
        <span className="flex flex-none items-center gap-2.5 text-[12.5px]">
          {corrida.coinciden > 0 && (
            <span className="font-semibold text-cos-jade-ink">{corrida.coinciden} coinciden</span>
          )}
          {corrida.difieren > 0 && (
            <span className="font-semibold text-cos-amber-ink">{corrida.difieren} difieren</span>
          )}
          {corrida.noComparables > 0 && (
            <span className="text-cos-ink-faint">{corrida.noComparables} sin comparar</span>
          )}
        </span>
      </button>

      {abierta && (
        <div className="pb-3 pl-7">
          {comparables.length > 0 && (
            <div className="max-h-[380px] overflow-auto rounded-control border border-cos-line">
              <table className="w-full min-w-[520px] text-[12.5px]">
                <thead className="sticky top-0 bg-cos-card">
                  <tr className="text-left text-cos-ink-faint">
                    <th className="px-3 py-1.5 font-medium">Concepto</th>
                    <th className="px-3 py-1.5 text-right font-medium">Timbrado</th>
                    <th className="px-3 py-1.5 text-right font-medium">Nuestro cálculo</th>
                    <th className="px-3 py-1.5 text-right font-medium">Diferencia</th>
                  </tr>
                </thead>
                <tbody>
                  {comparables.map((e) => (
                    <EmpleadoRows key={e.employeeId + (e.rfc ?? "")} empleado={e} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {noComparables.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[12.5px] text-cos-ink-faint">
              {noComparables.map((e, i) => (
                <li key={e.employeeId + i}>
                  <span className="text-cos-ink-soft">{e.nombre}</span> — sin comparar:{" "}
                  {e.comparacion.motivoNoComparable ?? "datos insuficientes"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function EmpleadoRows({ empleado }: { empleado: EmpleadoComparacion }) {
  const c = empleado.comparacion;
  const difiere = c.veredicto === "difiere";
  return (
    <>
      <tr className="border-t border-cos-line bg-cos-brand-tint/30">
        <td colSpan={3} className="px-3 py-1.5 font-semibold text-cos-ink">
          {empleado.nombre}
        </td>
        <td className="px-3 py-1.5 text-right">
          {difiere ? (
            <span className="font-semibold text-cos-amber-ink">Difiere</span>
          ) : (
            <span className="inline-flex items-center gap-1 font-semibold text-cos-jade-ink">
              <BadgeCheck className="h-3.5 w-3.5" /> Coincide
            </span>
          )}
        </td>
      </tr>
      {CONCEPTOS.map(({ key, label }) => {
        const v = c[key];
        if (!v) return null;
        const fueraDeTolerancia = Math.abs(v.delta) > 1;
        return (
          <tr key={key} className="border-t border-cos-line/60">
            <td className="px-3 py-1 text-cos-ink-soft">{label}</td>
            <td className="px-3 py-1 text-right font-mono text-cos-ink">{formatCurrency(v.timbrado)}</td>
            <td className="px-3 py-1 text-right font-mono text-cos-ink">{formatCurrency(v.nuestro)}</td>
            <td
              className={`px-3 py-1 text-right font-mono ${
                fueraDeTolerancia ? "font-semibold text-cos-amber-ink" : "text-cos-ink-faint"
              }`}
            >
              {deltaLabel(v.delta)}
            </td>
          </tr>
        );
      })}
    </>
  );
}
