"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Ajuste anual de ISR de sueldos (Art. 97 LISR) — reporte por trabajador.
//
// Página AUTOCONTENIDA (v1, sólo lectura): selecciona el ejercicio, muestra el
// cálculo anual de cada trabajador (estado, base gravada, ISR anual, retenido,
// diferencia y la acción de diciembre que implica) con encabezado de resumen y
// exportación CSV. NO modifica ninguna corrida — aplicar el ajuste a la nómina
// de diciembre es fase 2.
//
// «Presentará por su cuenta» (Art. 97, último párrafo, inciso c, LISR): el
// trabajador puede comunicar POR ESCRITO que presentará su propia declaración
// anual, lo que releva al patrón del cálculo. Eso no es conocible desde los
// datos, así que se expone como marcado por fila. LIMITACIÓN DOCUMENTADA: el
// marcado vive sólo en esta sesión del navegador (no se guarda en ningún lado);
// persistirlo requiere la fase 2.
// ─────────────────────────────────────────────────────────────────────────────

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle, ChevronLeft, Download, FileText, Info, Scale, Users2,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Loading, Money } from "@/components/ui";
import { formatCurrency } from "@/lib/utils";

// Espejo de los tipos del módulo (src/lib/nomina/ajuste-anual.ts).
interface EmpleadoAjuste {
  employeeId: string;
  nombre: string;
  rfc: string;
  numEmpleado: string | null;
  estado: "aplica" | "no-aplica";
  motivo: string | null;
  motivoDetalle: string | null;
  recibos: number;
  recibosSinXml: number;
  ingresosTotales: number;
  baseAnual: number | null;
  isrTarifaAnual: number | null;
  subsidioAnualCorrespondido: number | null;
  subsidioAplicado: number | null;
  mesesConSubsidio: number;
  isrAnual: number | null;
  retenidoAcumulado: number;
  diferencia: number | null;
  sentido: "a-cargo" | "a-favor" | "sin-diferencia" | null;
  accionDiciembre: string;
  advertencias: string[];
}

interface ReporteAjuste {
  ejercicio: number;
  tarifa: { ejercicio: number; fuente: string; verificado: boolean } | null;
  empleados: EmpleadoAjuste[];
  resumen: {
    total: number;
    aplican: number;
    noAplican: number;
    conCargo: number;
    conFavor: number;
    sumaACargo: number;
    sumaAFavor: number;
  };
  advertenciasGlobales: string[];
}

const MOTIVO_LABEL: Record<string, string> = {
  "sin-recibos": "Sin recibos del ejercicio",
  "periodo-incompleto": "Periodo incompleto (Art. 97 a)",
  "ingresos-mayores-400k": "Ingresos > $400,000 (Art. 97 b)",
  "pagos-por-separacion": "Pagos por separación",
  "salario-minimo": "Salario mínimo",
  "sin-xml": "Falta XML timbrado",
  "sin-tarifa": "Sin tarifa del ejercicio",
  "subsidio-regimen-2013": "Subsidio pre-decreto 2024",
};

// El decreto vigente de subsidio (base del cálculo) rige desde mayo de 2024;
// ejercicios anteriores no son reconstruibles → el selector arranca en 2024.
const PRIMER_EJERCICIO = 2024;

function csvEscape(v: string | number | null): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function AjusteAnualContenido() {
  const { activeCompany, loading: companyLoading } = useCompany();
  const searchParams = useSearchParams();

  const hoy = new Date();
  // Por defecto, el ejercicio "revisable": el año en curso sólo a partir de
  // diciembre (antes el cálculo saldría con meses faltantes); si la liga del
  // checklist trae ?ejercicio= se respeta.
  const ejercicioDefault =
    hoy.getMonth() + 1 === 12 ? hoy.getFullYear() : Math.max(PRIMER_EJERCICIO, hoy.getFullYear() - 1);
  const ejercicioParam = Number(searchParams.get("ejercicio"));
  const [ejercicio, setEjercicio] = useState(
    Number.isInteger(ejercicioParam) && ejercicioParam >= PRIMER_EJERCICIO && ejercicioParam <= hoy.getFullYear()
      ? ejercicioParam
      : ejercicioDefault
  );

  const [data, setData] = useState<ReporteAjuste | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Art. 97 c): marcado por sesión — NO se persiste (v1).
  const [porSuCuenta, setPorSuCuenta] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!activeCompany) return;
    setLoading(true);
    setError(null);
    setPorSuCuenta(new Set());
    fetch(`/api/nomina/ajuste-anual?companyId=${activeCompany.id}&ejercicio=${ejercicio}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json())?.error ?? "Error al calcular el ajuste anual");
        return r.json();
      })
      .then((d: ReporteAjuste) => setData(d))
      .catch((e) => setError(e instanceof Error ? e.message : "Error desconocido"))
      .finally(() => setLoading(false));
  }, [activeCompany, ejercicio]);

  const togglePorSuCuenta = (id: string) =>
    setPorSuCuenta((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Resumen EFECTIVO: los marcados «presentará por su cuenta» (Art. 97 c) salen
  // del conjunto con ajuste — se recalcula en el cliente sobre el marcado vivo.
  const resumen = useMemo(() => {
    if (!data) return null;
    const aplican = data.empleados.filter((e) => e.estado === "aplica" && !porSuCuenta.has(e.employeeId));
    const conCargo = aplican.filter((e) => e.sentido === "a-cargo");
    const conFavor = aplican.filter((e) => e.sentido === "a-favor");
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      total: data.empleados.length,
      aplican: aplican.length,
      noAplican: data.empleados.length - aplican.length,
      conCargo: conCargo.length,
      conFavor: conFavor.length,
      sumaACargo: r2(conCargo.reduce((s, e) => s + (e.diferencia ?? 0), 0)),
      sumaAFavor: r2(conFavor.reduce((s, e) => s + Math.abs(e.diferencia ?? 0), 0)),
    };
  }, [data, porSuCuenta]);

  function exportarCsv() {
    if (!data) return;
    const encabezados = [
      "Empleado", "RFC", "Núm. empleado", "Estado", "Motivo", "Recibos",
      "Ingresos totales", "Base gravada anual", "ISR tarifa anual (Art. 152)",
      "Subsidio anual correspondido", "ISR anual", "ISR retenido acumulado",
      "Diferencia", "Sentido", "Acción en diciembre",
    ];
    const filas = data.empleados.map((e) => {
      const marcado = porSuCuenta.has(e.employeeId);
      return [
        e.nombre, e.rfc, e.numEmpleado ?? "",
        marcado ? "no-aplica" : e.estado,
        marcado ? "Presentará por su cuenta (Art. 97 c)" : (e.motivo ? MOTIVO_LABEL[e.motivo] ?? e.motivo : ""),
        e.recibos, e.ingresosTotales,
        e.baseAnual ?? "", e.isrTarifaAnual ?? "", e.subsidioAnualCorrespondido ?? "",
        e.isrAnual ?? "", e.retenidoAcumulado, e.diferencia ?? "",
        marcado ? "" : (e.sentido ?? ""),
        marcado
          ? "El trabajador comunicó que presentará su propia declaración anual; el retenedor no efectúa el cálculo."
          : e.accionDiciembre,
      ].map(csvEscape).join(",");
    });
    // BOM para que Excel abra el CSV en UTF-8 con acentos correctos.
    const csv = "\uFEFF" + [encabezados.map(csvEscape).join(","), ...filas].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ajuste-anual-isr-${ejercicio}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (companyLoading) return <Loading />;
  if (!activeCompany) {
    return (
      <div className="mx-auto max-w-[1200px] px-6 py-7">
        <p className="text-[13.5px] text-cos-ink-faint">Selecciona una empresa para ver el ajuste anual.</p>
      </div>
    );
  }

  const ejercicios: number[] = [];
  for (let y = hoy.getFullYear(); y >= PRIMER_EJERCICIO; y--) ejercicios.push(y);
  const ejercicioEnCurso = ejercicio === hoy.getFullYear() && hoy.getMonth() + 1 < 12;

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-7">
      <Link href="/nomina" className="inline-flex items-center gap-1 text-[13px] text-cos-ink-faint hover:text-cos-brand-ink">
        <ChevronLeft className="h-4 w-4" /> Nómina
      </Link>

      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-bold tracking-[-0.02em] text-cos-ink">Ajuste anual de ISR de sueldos</h1>
          <p className="mt-0.5 text-[14px] text-cos-ink-soft">
            Cálculo anual del retenedor (Art. 97 LISR): ISR del ejercicio con la tarifa anual vs. lo retenido mes a mes.
            Sólo reporte — no modifica ninguna corrida.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[12px] text-cos-ink-soft">
            Ejercicio
            <select
              value={ejercicio}
              onChange={(e) => setEjercicio(Number(e.target.value))}
              className="ml-2 rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[13px] text-cos-ink"
            >
              {ejercicios.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </label>
          <button
            onClick={exportarCsv}
            disabled={!data || data.empleados.length === 0}
            className="inline-flex items-center gap-2 rounded-control border border-cos-line bg-cos-card px-4 py-2 text-[13.5px] font-semibold text-cos-ink hover:bg-cos-paper disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-4 w-4" /> Exportar CSV
          </button>
        </div>
      </div>

      {ejercicioEnCurso && (
        <div className="mt-4 flex items-start gap-2 rounded-control border border-cos-amber bg-cos-amber-tint px-4 py-3 text-[12.5px] text-cos-amber-ink">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            El ejercicio {ejercicio} aún no termina: el cálculo sólo es definitivo con la nómina de todo el año
            (el ajuste se practica en diciembre). Las cifras mostradas son parciales.
          </span>
        </div>
      )}

      {loading && <Loading />}
      {error && <p className="mt-5 text-[13px] text-cos-red-ink">{error}</p>}

      {!loading && data && resumen && (
        <>
          {/* ── Resumen ── */}
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-card border border-cos-line bg-cos-card px-4 py-3 shadow-card">
              <p className="flex items-center gap-1.5 text-[12px] text-cos-ink-faint"><Users2 className="h-3.5 w-3.5" /> Con ajuste calculable</p>
              <p className="mt-1 font-mono text-[20px] font-bold text-cos-ink">{resumen.aplican}</p>
              <p className="text-[11.5px] text-cos-ink-faint">de {resumen.total} trabajadores</p>
            </div>
            <div className="rounded-card border border-cos-line bg-cos-card px-4 py-3 shadow-card">
              <p className="text-[12px] text-cos-ink-faint">Diferencias a cargo</p>
              <p className="mt-1 font-mono text-[20px] font-bold text-cos-amber-ink">{formatCurrency(resumen.sumaACargo)}</p>
              <p className="text-[11.5px] text-cos-ink-faint">{resumen.conCargo} trabajador(es) — se retiene en diciembre</p>
            </div>
            <div className="rounded-card border border-cos-line bg-cos-card px-4 py-3 shadow-card">
              <p className="text-[12px] text-cos-ink-faint">Diferencias a favor</p>
              <p className="mt-1 font-mono text-[20px] font-bold text-cos-jade-ink">{formatCurrency(resumen.sumaAFavor)}</p>
              <p className="text-[11.5px] text-cos-ink-faint">{resumen.conFavor} trabajador(es) — se compensa desde diciembre</p>
            </div>
            <div className="rounded-card border border-cos-line bg-cos-card px-4 py-3 shadow-card">
              <p className="text-[12px] text-cos-ink-faint">Sin cálculo anual</p>
              <p className="mt-1 font-mono text-[20px] font-bold text-cos-ink">{resumen.noAplican}</p>
              <p className="text-[11.5px] text-cos-ink-faint">exclusiones del Art. 97 y datos incompletos</p>
            </div>
          </div>

          {data.tarifa && (
            <p className="mt-3 flex items-start gap-1.5 text-[12px] text-cos-ink-faint">
              <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Tarifa anual aplicada: {data.tarifa.fuente}
              {data.tarifa.ejercicio !== data.ejercicio && ` (tabla de ${data.tarifa.ejercicio}, vigente por roll-forward)`}
              {!data.tarifa.verificado && " — SIN COTEJAR contra el Anexo 8"}
            </p>
          )}
          {data.advertenciasGlobales.map((a, i) => (
            <p key={i} className="mt-2 flex items-start gap-1.5 text-[12.5px] text-cos-amber-ink">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {a}
            </p>
          ))}

          {/* ── Tabla por trabajador ── */}
          <div className="mt-5 overflow-x-auto rounded-card border border-cos-line bg-cos-card shadow-card">
            <table className="w-full min-w-[980px] text-sm">
              <thead className="bg-cos-paper text-[12px] uppercase tracking-[0.02em] text-cos-ink-faint">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Trabajador</th>
                  <th className="px-3 py-2.5 text-left font-medium">Estado</th>
                  <th className="px-3 py-2.5 text-right font-medium">Base gravada</th>
                  <th className="px-3 py-2.5 text-right font-medium">ISR anual</th>
                  <th className="px-3 py-2.5 text-right font-medium">Retenido</th>
                  <th className="px-3 py-2.5 text-right font-medium">Diferencia</th>
                  <th className="px-3 py-2.5 text-left font-medium">Acción en diciembre</th>
                  <th className="px-3 py-2.5 text-center font-medium" title="Art. 97, último párrafo, inciso c, LISR">
                    Presentará por su cuenta
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.empleados.map((e) => {
                  const marcado = porSuCuenta.has(e.employeeId);
                  const efectivoAplica = e.estado === "aplica" && !marcado;
                  return (
                    <tr key={e.employeeId} className={`border-t border-cos-line ${marcado ? "opacity-60" : ""}`}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-cos-ink">{e.nombre}</p>
                        <p className="font-mono text-[11px] text-cos-ink-faint">{e.rfc} · {e.recibos} recibo(s)</p>
                      </td>
                      <td className="px-3 py-3">
                        {marcado ? (
                          <span className="inline-flex rounded-full bg-cos-slate-tint px-2 py-0.5 text-[12px] font-medium text-cos-ink-faint">
                            Presentará por su cuenta
                          </span>
                        ) : e.estado === "aplica" ? (
                          <span className="inline-flex rounded-full bg-cos-jade-tint px-2 py-0.5 text-[12px] font-medium text-cos-jade-ink">
                            Aplica
                          </span>
                        ) : (
                          <span
                            className="inline-flex rounded-full bg-cos-slate-tint px-2 py-0.5 text-[12px] font-medium text-cos-ink-faint"
                            title={e.motivoDetalle ?? undefined}
                          >
                            {MOTIVO_LABEL[e.motivo ?? ""] ?? "No aplica"}
                          </span>
                        )}
                        {e.advertencias.length > 0 && !marcado && (
                          <p className="mt-1 flex items-start gap-1 text-[11px] text-cos-amber-ink" title={e.advertencias.join(" · ")}>
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {e.advertencias.length} advertencia(s)
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right font-mono">
                        {e.baseAnual != null ? formatCurrency(e.baseAnual) : <span className="text-cos-ink-faint">—</span>}
                      </td>
                      <td className="px-3 py-3 text-right font-mono">
                        {efectivoAplica && e.isrAnual != null ? (
                          <span title={`Tarifa Art. 152: ${formatCurrency(e.isrTarifaAnual ?? 0)}${(e.subsidioAnualCorrespondido ?? 0) > 0 ? ` − subsidio ${formatCurrency(e.subsidioAplicado ?? 0)} (${e.mesesConSubsidio} mes(es))` : ""}`}>
                            <Money value={e.isrAnual} />
                          </span>
                        ) : (
                          <span className="text-cos-ink-faint">—</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right font-mono"><Money value={e.retenidoAcumulado} /></td>
                      <td className="px-3 py-3 text-right font-mono">
                        {efectivoAplica && e.diferencia != null ? (
                          <span className={e.sentido === "a-cargo" ? "text-cos-amber-ink" : e.sentido === "a-favor" ? "text-cos-jade-ink" : ""}>
                            {e.sentido === "a-favor" ? "−" : ""}{formatCurrency(Math.abs(e.diferencia))}
                            <span className="block text-[10.5px] font-normal">
                              {e.sentido === "a-cargo" ? "a cargo" : e.sentido === "a-favor" ? "a favor" : "sin diferencia"}
                            </span>
                          </span>
                        ) : (
                          <span className="text-cos-ink-faint">—</span>
                        )}
                      </td>
                      <td className="max-w-[280px] px-3 py-3 text-[12px] text-cos-ink-soft">
                        {marcado
                          ? "El trabajador comunicó por escrito que presentará su propia declaración anual; conserva ese escrito (Art. 97, inciso c, LISR)."
                          : e.accionDiciembre}
                      </td>
                      <td className="px-3 py-3 text-center">
                        {e.estado === "aplica" && (
                          <input
                            type="checkbox"
                            checked={marcado}
                            onChange={() => togglePorSuCuenta(e.employeeId)}
                            className="h-4 w-4 accent-cos-brand"
                            aria-label={`${e.nombre} presentará por su cuenta`}
                          />
                        )}
                      </td>
                    </tr>
                  );
                })}
                {data.empleados.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-[13.5px] text-cos-ink-faint">
                      Sin trabajadores con nómina timbrada en el ejercicio {ejercicio}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* ── Notas legales y limitaciones ── */}
          <div className="mt-5 rounded-card border border-cos-line bg-cos-card px-5 py-4 shadow-card">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-cos-ink">
              <FileText className="h-4 w-4" /> Base legal y alcance del cálculo
            </p>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-[12.5px] text-cos-ink-soft">
              <li>
                Impuesto anual: totalidad de los ingresos gravados del ejercicio por sueldos y salarios, con la tarifa
                anual del Art. 152 LISR; contra el resultado se acreditan las retenciones mensuales del Art. 96
                (Art. 97, párrafos primero y segundo, LISR). El impuesto local a salarios no se registra en el sistema
                y se considera $0.00.
              </li>
              <li>
                Subsidio para el empleo: el impuesto anual se disminuye con la suma del subsidio MENSUAL que
                correspondió al trabajador (decreto DOF 01-may-2024, Artículo Tercero, fracc. I-III; modificaciones
                DOF 31-dic-2024 y DOF 31-dic-2025). El derecho de cada mes se reconstruye comparando la base gravada
                del mes de calendario contra el tope del ejercicio; el subsidio nunca genera saldo a favor.
              </li>
              <li>
                Diferencia a cargo: se retiene al trabajador y se entera a más tardar en febrero. Diferencia a favor:
                se compensa contra la retención de diciembre y las sucesivas, a más tardar dentro del año siguiente
                (Art. 97, cuarto párrafo, LISR).
              </li>
              <li>
                Sin cálculo anual (Art. 97, último párrafo): quienes iniciaron después del 1 de enero o causaron baja
                antes del 1 de diciembre; quienes obtuvieron ingresos anuales superiores a $400,000.00; y quienes
                comuniquen por escrito que presentarán su propia declaración.
              </li>
              <li>
                El marcado «presentará por su cuenta» NO se guarda: vive únicamente en esta sesión del navegador y se
                pierde al recargar. Conserva el escrito del trabajador como respaldo (persistirlo en el sistema es
                fase 2, junto con aplicar el ajuste a la corrida de diciembre).
              </li>
              <li>
                La base gravada se re-parsea del XML timbrado de cada recibo (nativo o importado del SAT). Los
                trabajadores con recibos sin XML, con pagos por separación (Art. 95 LISR), de salario mínimo o con
                meses de 2024 previos al decreto de subsidio se marcan sin cálculo, con el motivo visible.
              </li>
            </ul>
            <p className="mt-3 flex items-start gap-1.5 text-[12px] text-cos-ink-faint">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Este reporte es de apoyo para practicar el ajuste en la nómina de diciembre; no sustituye la revisión
              del contador ni aplica cambios a ninguna corrida.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

export default function AjusteAnualPage() {
  // useSearchParams exige un límite de Suspense en el App Router.
  return (
    <Suspense fallback={<Loading />}>
      <AjusteAnualContenido />
    </Suspense>
  );
}
