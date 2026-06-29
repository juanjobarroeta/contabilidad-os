"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Cockpit multi-RFC de nómina — el panel del despacho de outsourcing: el estado
// de la nómina de TODAS las empresas a las que tienes acceso, en una tabla, con
// semáforo operativo y salto directo a operar cada una (cambia la empresa
// activa y entra al workspace).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Building2, Users2, AlertTriangle, BadgeCheck, Clock4, CircleDashed,
  ChevronLeft, ChevronRight as ChevronR, Settings2, Calculator, X, CheckCircle2, XCircle, MinusCircle,
  Download,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Loading, Money } from "@/components/ui";
import { formatCurrency, formatDate } from "@/lib/utils";

interface CockpitCompany {
  id: string;
  rfc: string;
  razonSocial: string;
  regimenFiscal: string;
  empleadosActivos: number;
  masaSalarialDiaria: number;
  bajoMinimo: number;
  corridasDelMes: number;
  netoDelMes: number;
  corridasSinTimbrar: number;
  ultimaCorrida: { periodo: string; tipo: string; status: string; fechaPago: string; totalNeto: number } | null;
  setupCompleto: boolean;
}

interface CockpitData {
  salarioMinimoGeneral: number;
  periodo: string;
  companies: CockpitCompany[];
}

// Resultado por empresa que devuelve POST /api/nomina/cockpit/batch-calcular.
interface BatchResult {
  companyId: string;
  razonSocial: string;
  runId?: string;
  itemCount?: number;
  totalNeto?: number;
  skipped?: string;
  error?: string;
  warnings?: string[];
}
interface BatchResponse {
  ok: boolean;
  results: BatchResult[];
  creados: number;
  omitidos: number;
  errores: number;
}

const TIPO_RUN_OPCIONES = ["ORDINARIA", "EXTRAORDINARIA", "AGUINALDO", "VACACIONES", "PTU"] as const;

const TIPO_RUN_LABEL: Record<string, string> = {
  ORDINARIA: "Ordinaria",
  EXTRAORDINARIA: "Extraordinaria",
  FINIQUITO: "Finiquito",
  AGUINALDO: "Aguinaldo",
  VACACIONES: "Vacaciones",
  PTU: "PTU",
};

// Semáforo operativo del mes, en orden de urgencia.
type Estado = { label: string; cls: string; icon: typeof BadgeCheck };
function estadoDe(c: CockpitCompany): Estado {
  if (c.empleadosActivos === 0)
    return { label: "Sin empleados", cls: "bg-cos-slate-tint text-cos-ink-faint", icon: CircleDashed };
  if (!c.setupCompleto)
    return { label: "Setup incompleto", cls: "bg-cos-amber-tint text-cos-amber-ink", icon: Settings2 };
  if (c.corridasSinTimbrar > 0)
    return { label: `${c.corridasSinTimbrar} sin timbrar`, cls: "bg-cos-amber-tint text-cos-amber-ink", icon: Clock4 };
  if (c.corridasDelMes === 0)
    return { label: "Sin corrida este mes", cls: "bg-cos-red-tint text-cos-red-ink", icon: AlertTriangle };
  return { label: "Al corriente", cls: "bg-cos-jade-tint text-cos-jade-ink", icon: BadgeCheck };
}

export default function NominaCockpitPage() {
  const { companies, setActiveCompany } = useCompany();
  const router = useRouter();
  const [data, setData] = useState<CockpitData | null>(null);
  const [loading, setLoading] = useState(true);

  // Estado del comando "Calcular quincena" en lote.
  const [panelAbierto, setPanelAbierto] = useState(false);
  // Estado del comando "Descargar dispersión" en lote.
  const [dispersionAbierta, setDispersionAbierta] = useState(false);

  const fetchCockpit = useCallback(() => {
    return fetch("/api/nomina/cockpit")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: CockpitData | null) => setData(d));
  }, []);

  useEffect(() => {
    fetchCockpit().finally(() => setLoading(false));
  }, [fetchCockpit]);

  // Cambia la empresa activa del contexto y entra a su workspace de nómina.
  function operar(c: CockpitCompany, destino: "/nomina" | "/nomina/detalle") {
    const found = companies.find((x) => x.id === c.id);
    if (found) setActiveCompany(found);
    router.push(destino);
  }

  if (loading) return <Loading />;
  // Triage: las que necesitan acción primero (sin corrida → sin timbrar/setup →
  // al corriente → sin empleados), para procesar la quincena de arriba a abajo.
  const urgencia = (c: CockpitCompany): number => {
    if (c.empleadosActivos === 0) return 0;
    const label = estadoDe(c).label;
    if (label === "Sin corrida este mes") return 4;
    if (label.includes("sin timbrar") || label === "Setup incompleto") return 3;
    if (label === "Al corriente") return 1;
    return 2;
  };
  const rows = [...(data?.companies ?? [])].sort((a, b) => urgencia(b) - urgencia(a));
  const totEmpleados = rows.reduce((s, c) => s + c.empleadosActivos, 0);
  const totNetoMes = rows.reduce((s, c) => s + c.netoDelMes, 0);
  const conPendientes = rows.filter((c) => estadoDe(c).label !== "Al corriente" && c.empleadosActivos > 0).length;
  // Empresas que necesitan corrida este mes: con equipo, setup listo y sin
  // corrida registrada del mes. Es el conjunto por defecto del comando en lote.
  const necesitanCorrida = rows.filter(
    (c) => c.empleadosActivos > 0 && c.setupCompleto && c.corridasDelMes === 0
  );
  // Empresas con corrida registrada del mes: el conjunto dispersable por defecto.
  const conCorrida = rows.filter((c) => c.corridasDelMes > 0);

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-7">
      <Link href="/nomina" className="inline-flex items-center gap-1 text-[13px] text-cos-ink-faint hover:text-cos-brand-ink">
        <ChevronLeft className="h-4 w-4" /> Nómina
      </Link>
      <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-bold tracking-[-0.02em] text-cos-ink">Cockpit de nómina</h1>
          <p className="mt-0.5 text-[14px] text-cos-ink-soft">
            Todas tus empresas en un panel — corre, timbra y detecta pendientes sin cambiar de contexto.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setDispersionAbierta(true)}
            disabled={conCorrida.length === 0}
            className="inline-flex items-center gap-2 rounded-control border border-cos-line bg-cos-card px-4 py-2 text-[13.5px] font-semibold text-cos-ink hover:bg-cos-paper disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            Descargar dispersión
          </button>
          <button
            onClick={() => setPanelAbierto(true)}
            disabled={necesitanCorrida.length === 0}
            className="inline-flex items-center gap-2 rounded-control bg-cos-brand px-4 py-2 text-[13.5px] font-semibold text-white hover:bg-cos-brand-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Calculator className="h-4 w-4" />
            {necesitanCorrida.length > 0
              ? `Calcular quincena de ${necesitanCorrida.length} empresa${necesitanCorrida.length === 1 ? "" : "s"}`
              : "Calcular quincena"}
          </button>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
        <div className="flex gap-5 text-[13px] text-cos-ink-soft">
          <span className="inline-flex items-center gap-1.5"><Building2 className="h-4 w-4 text-cos-ink-faint" /> <b className="font-mono">{rows.length}</b> empresas</span>
          <span className="inline-flex items-center gap-1.5"><Users2 className="h-4 w-4 text-cos-ink-faint" /> <b className="font-mono">{totEmpleados}</b> empleados</span>
          <span>Neto del mes: <b className="font-mono"><Money value={totNetoMes} /></b></span>
          {conPendientes > 0 && (
            <span className="text-cos-amber-ink"><b className="font-mono">{conPendientes}</b> con pendientes</span>
          )}
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-card border border-cos-line bg-cos-card shadow-card">
        <table className="w-full text-sm">
          <thead className="bg-cos-paper text-[12px] uppercase tracking-[0.02em] text-cos-ink-faint">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Empresa</th>
              <th className="px-3 py-2.5 text-right font-medium">Empleados</th>
              <th className="px-3 py-2.5 text-right font-medium">Neto del mes</th>
              <th className="px-3 py-2.5 text-left font-medium">Última corrida</th>
              <th className="px-3 py-2.5 text-left font-medium">Estado</th>
              <th className="px-3 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const est = estadoDe(c);
              const Icon = est.icon;
              return (
                <tr key={c.id} className="border-t border-cos-line hover:bg-cos-paper/60">
                  <td className="px-4 py-3">
                    <p className="font-medium text-cos-ink">{c.razonSocial}</p>
                    <p className="font-mono text-[11px] text-cos-ink-faint">{c.rfc}</p>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <span className="font-mono">{c.empleadosActivos}</span>
                    {c.bajoMinimo > 0 && (
                      <p className="text-[11px] text-cos-amber-ink" title={`Salario diario menor a ${formatCurrency(data?.salarioMinimoGeneral ?? 0)}`}>
                        ⚠ {c.bajoMinimo} bajo mínimo
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right font-mono">
                    {c.netoDelMes > 0 ? formatCurrency(c.netoDelMes) : <span className="text-cos-ink-faint">—</span>}
                    {c.corridasDelMes > 1 && <p className="text-[11px] text-cos-ink-faint">{c.corridasDelMes} corridas</p>}
                  </td>
                  <td className="px-3 py-3">
                    {c.ultimaCorrida ? (
                      <>
                        <p className="text-[13px] text-cos-ink">
                          {TIPO_RUN_LABEL[c.ultimaCorrida.tipo] ?? c.ultimaCorrida.tipo} · <Money value={c.ultimaCorrida.totalNeto} />
                        </p>
                        <p className="text-[11px] text-cos-ink-faint">pago {formatDate(c.ultimaCorrida.fechaPago)}</p>
                      </>
                    ) : (
                      <span className="text-[13px] text-cos-ink-faint">Sin corridas</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium ${est.cls}`}>
                      <Icon className="h-3.5 w-3.5" /> {est.label}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      onClick={() => operar(c, "/nomina/detalle")}
                      className="inline-flex items-center gap-1 rounded-control bg-cos-brand px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-cos-brand-deep"
                    >
                      Operar <ChevronR className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-[13.5px] text-cos-ink-faint">
                  Sin empresas accesibles.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-[12px] text-cos-ink-faint">
        "Al corriente" = corrida del mes registrada y todo timbrado. "Operar" cambia la empresa activa y abre su workspace.
      </p>

      {panelAbierto && (
        <BatchCalcularPanel
          empresas={rows}
          preseleccion={necesitanCorrida.map((c) => c.id)}
          onClose={() => setPanelAbierto(false)}
          onDone={fetchCockpit}
        />
      )}

      {dispersionAbierta && (
        <BatchDispersionPanel
          empresas={rows}
          preseleccion={conCorrida.map((c) => c.id)}
          onClose={() => setDispersionAbierta(false)}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Comando "Descargar dispersión" en lote. Genera UN solo CSV de dispersión SPEI
// con todos los empleados de las empresas seleccionadas que tengan corrida
// (CALCULATED/STAMPED) para la quincena indicada. Acción de sólo lectura: no
// timbra, no ejecuta pagos, no cambia estado. Descarga directa vía GET.
// ─────────────────────────────────────────────────────────────────────────────
function BatchDispersionPanel({
  empresas,
  preseleccion,
  onClose,
}: {
  empresas: CockpitCompany[];
  preseleccion: string[];
  onClose: () => void;
}) {
  // Quincena del mes en curso por defecto: 1–15 (misma convención que calcular).
  const hoy = new Date();
  const iso = (d: Date) => d.toISOString().split("T")[0];
  const ini = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const fin = new Date(hoy.getFullYear(), hoy.getMonth(), 15);

  const [periodoInicio, setPeriodoInicio] = useState(iso(ini));
  const [periodoFin, setPeriodoFin] = useState(iso(fin));
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set(preseleccion));

  // Empresas con corrida del mes: las que pueden tener dispersión.
  const elegibles = useMemo(
    () => empresas.filter((c) => c.corridasDelMes > 0),
    [empresas]
  );

  const toggle = (id: string) =>
    setSeleccion((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  function descargar() {
    const params = new URLSearchParams({
      companyIds: Array.from(seleccion).join(","),
      periodoInicio,
      periodoFin,
    });
    // Descarga directa: el endpoint responde con Content-Disposition attachment.
    window.location.href = `/api/nomina/cockpit/batch-dispersion?${params.toString()}`;
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-cos-ink/40 p-4 py-10">
      <div className="w-full max-w-[680px] rounded-card border border-cos-line bg-cos-card shadow-card">
        <div className="flex items-center justify-between border-b border-cos-line px-5 py-4">
          <div>
            <h2 className="text-[17px] font-bold tracking-[-0.01em] text-cos-ink">Descargar dispersión en lote</h2>
            <p className="mt-0.5 text-[12.5px] text-cos-ink-soft">
              Un solo archivo CSV de dispersión SPEI con los empleados de varias empresas para la misma quincena. Sólo exporta — no timbra ni ejecuta pagos.
            </p>
          </div>
          <button onClick={onClose} className="rounded-control p-1 text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink" aria-label="Cerrar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 px-5 py-4">
          <label className="text-[12px] text-cos-ink-soft">
            Periodo inicio
            <input
              type="date"
              value={periodoInicio}
              onChange={(e) => setPeriodoInicio(e.target.value)}
              className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[13px] text-cos-ink"
            />
          </label>
          <label className="text-[12px] text-cos-ink-soft">
            Periodo fin
            <input
              type="date"
              value={periodoFin}
              onChange={(e) => setPeriodoFin(e.target.value)}
              className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[13px] text-cos-ink"
            />
          </label>
        </div>

        <div className="border-t border-cos-line px-5 py-3">
          <div className="mb-2 flex items-center justify-between text-[12px] text-cos-ink-soft">
            <span><b className="font-mono text-cos-ink">{seleccion.size}</b> de {elegibles.length} empresas seleccionadas</span>
            <div className="flex gap-3">
              <button onClick={() => setSeleccion(new Set(elegibles.map((c) => c.id)))} className="text-cos-brand-ink hover:underline">Todas</button>
              <button onClick={() => setSeleccion(new Set())} className="text-cos-ink-faint hover:underline">Ninguna</button>
            </div>
          </div>
          <div className="max-h-[240px] overflow-y-auto rounded-control border border-cos-line">
            {elegibles.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-2.5 border-b border-cos-line px-3 py-2 last:border-b-0 hover:bg-cos-paper/60">
                <input
                  type="checkbox"
                  checked={seleccion.has(c.id)}
                  onChange={() => toggle(c.id)}
                  className="h-4 w-4 accent-cos-brand"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-cos-ink">{c.razonSocial}</span>
                  <span className="block font-mono text-[11px] text-cos-ink-faint">{c.rfc} · {c.empleadosActivos} empleados</span>
                </span>
                <span className="rounded-full bg-cos-slate-tint px-2 py-0.5 text-[11px] font-medium text-cos-ink-faint">
                  {c.corridasDelMes} corrida{c.corridasDelMes === 1 ? "" : "s"}
                </span>
              </label>
            ))}
            {elegibles.length === 0 && (
              <p className="px-3 py-6 text-center text-[12.5px] text-cos-ink-faint">No hay empresas con corrida este mes.</p>
            )}
          </div>
          <p className="mt-2 text-[11.5px] text-cos-ink-faint">
            Se incluye, por empresa, la corrida más reciente del periodo en estado calculado o timbrado. Las empresas sin corrida para ese periodo se omiten del archivo.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-cos-line px-5 py-4">
          <button onClick={onClose} className="rounded-control px-3 py-2 text-[13px] font-medium text-cos-ink-soft hover:bg-cos-paper">Cancelar</button>
          <button
            onClick={descargar}
            disabled={seleccion.size === 0}
            className="inline-flex items-center gap-2 rounded-control bg-cos-brand px-4 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            Descargar {seleccion.size} empresa{seleccion.size === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Comando "Calcular quincena" en lote. Sólo CREA + CALCULA corridas (reversible);
// no timbra ni dispersa. Permite ajustar tipo, periodo, fecha de pago y días, y
// elegir las empresas con casillas. Reporta por empresa: creada / omitida / error.
// ─────────────────────────────────────────────────────────────────────────────
function BatchCalcularPanel({
  empresas,
  preseleccion,
  onClose,
  onDone,
}: {
  empresas: CockpitCompany[];
  preseleccion: string[];
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  // Quincena del mes en curso por defecto: 1–15 y pago el día 15.
  const hoy = new Date();
  const iso = (d: Date) => d.toISOString().split("T")[0];
  const ini = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const fin = new Date(hoy.getFullYear(), hoy.getMonth(), 15);

  const [tipo, setTipo] = useState<string>("ORDINARIA");
  const [periodoInicio, setPeriodoInicio] = useState(iso(ini));
  const [periodoFin, setPeriodoFin] = useState(iso(fin));
  const [fechaPago, setFechaPago] = useState(iso(fin));
  const [diasPagados, setDiasPagados] = useState(15);
  const [seleccion, setSeleccion] = useState<Set<string>>(new Set(preseleccion));
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<BatchResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Empresas elegibles para el lote (con equipo); se muestran con casilla.
  const elegibles = useMemo(
    () => empresas.filter((c) => c.empleadosActivos > 0),
    [empresas]
  );

  const toggle = (id: string) =>
    setSeleccion((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const totalWarnings = resultado
    ? resultado.results.reduce((s, r) => s + (r.warnings?.length ?? 0), 0)
    : 0;

  async function enviar() {
    setEnviando(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/nomina/cockpit/batch-calcular", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          companyIds: Array.from(seleccion),
          tipo,
          periodoInicio,
          periodoFin,
          fechaPago,
          diasPagados: Number(diasPagados),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json?.error ?? "No se pudo procesar el lote.");
        return;
      }
      setResultado(json as BatchResponse);
      await onDone();
    } catch {
      setErrorMsg("Error de red al procesar el lote.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-cos-ink/40 p-4 py-10">
      <div className="w-full max-w-[680px] rounded-card border border-cos-line bg-cos-card shadow-card">
        <div className="flex items-center justify-between border-b border-cos-line px-5 py-4">
          <div>
            <h2 className="text-[17px] font-bold tracking-[-0.01em] text-cos-ink">Calcular quincena en lote</h2>
            <p className="mt-0.5 text-[12.5px] text-cos-ink-soft">
              Crea y calcula la corrida (ISR, IMSS, INFONAVIT) de varias empresas. No timbra ni dispersa — es reversible.
            </p>
          </div>
          <button onClick={onClose} className="rounded-control p-1 text-cos-ink-faint hover:bg-cos-paper hover:text-cos-ink" aria-label="Cerrar">
            <X className="h-5 w-5" />
          </button>
        </div>

        {!resultado ? (
          <>
            <div className="grid grid-cols-2 gap-3 px-5 py-4 sm:grid-cols-3">
              <label className="text-[12px] text-cos-ink-soft">
                Tipo
                <select
                  value={tipo}
                  onChange={(e) => setTipo(e.target.value)}
                  className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[13px] text-cos-ink"
                >
                  {TIPO_RUN_OPCIONES.map((t) => (
                    <option key={t} value={t}>{TIPO_RUN_LABEL[t] ?? t}</option>
                  ))}
                </select>
              </label>
              <label className="text-[12px] text-cos-ink-soft">
                Días pagados
                <input
                  type="number"
                  min={1}
                  value={diasPagados}
                  onChange={(e) => setDiasPagados(Number(e.target.value))}
                  className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[13px] text-cos-ink"
                />
              </label>
              <label className="text-[12px] text-cos-ink-soft">
                Fecha de pago
                <input
                  type="date"
                  value={fechaPago}
                  onChange={(e) => setFechaPago(e.target.value)}
                  className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[13px] text-cos-ink"
                />
              </label>
              <label className="text-[12px] text-cos-ink-soft">
                Periodo inicio
                <input
                  type="date"
                  value={periodoInicio}
                  onChange={(e) => setPeriodoInicio(e.target.value)}
                  className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[13px] text-cos-ink"
                />
              </label>
              <label className="text-[12px] text-cos-ink-soft">
                Periodo fin
                <input
                  type="date"
                  value={periodoFin}
                  onChange={(e) => setPeriodoFin(e.target.value)}
                  className="mt-1 w-full rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[13px] text-cos-ink"
                />
              </label>
            </div>

            <div className="border-t border-cos-line px-5 py-3">
              <div className="mb-2 flex items-center justify-between text-[12px] text-cos-ink-soft">
                <span><b className="font-mono text-cos-ink">{seleccion.size}</b> de {elegibles.length} empresas seleccionadas</span>
                <div className="flex gap-3">
                  <button onClick={() => setSeleccion(new Set(elegibles.map((c) => c.id)))} className="text-cos-brand-ink hover:underline">Todas</button>
                  <button onClick={() => setSeleccion(new Set())} className="text-cos-ink-faint hover:underline">Ninguna</button>
                </div>
              </div>
              <div className="max-h-[240px] overflow-y-auto rounded-control border border-cos-line">
                {elegibles.map((c) => {
                  const yaTiene = c.corridasDelMes > 0;
                  return (
                    <label key={c.id} className="flex cursor-pointer items-center gap-2.5 border-b border-cos-line px-3 py-2 last:border-b-0 hover:bg-cos-paper/60">
                      <input
                        type="checkbox"
                        checked={seleccion.has(c.id)}
                        onChange={() => toggle(c.id)}
                        className="h-4 w-4 accent-cos-brand"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-cos-ink">{c.razonSocial}</span>
                        <span className="block font-mono text-[11px] text-cos-ink-faint">{c.rfc} · {c.empleadosActivos} empleados</span>
                      </span>
                      {!c.setupCompleto && (
                        <span className="rounded-full bg-cos-amber-tint px-2 py-0.5 text-[11px] font-medium text-cos-amber-ink">Setup incompleto</span>
                      )}
                      {yaTiene && (
                        <span className="rounded-full bg-cos-slate-tint px-2 py-0.5 text-[11px] font-medium text-cos-ink-faint">Ya tiene corrida</span>
                      )}
                    </label>
                  );
                })}
                {elegibles.length === 0 && (
                  <p className="px-3 py-6 text-center text-[12.5px] text-cos-ink-faint">No hay empresas con empleados activos.</p>
                )}
              </div>
            </div>

            {errorMsg && (
              <p className="px-5 text-[12.5px] text-cos-red-ink">{errorMsg}</p>
            )}

            <div className="flex items-center justify-end gap-2 border-t border-cos-line px-5 py-4">
              <button onClick={onClose} className="rounded-control px-3 py-2 text-[13px] font-medium text-cos-ink-soft hover:bg-cos-paper">Cancelar</button>
              <button
                onClick={enviar}
                disabled={enviando || seleccion.size === 0}
                className="inline-flex items-center gap-2 rounded-control bg-cos-brand px-4 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Calculator className="h-4 w-4" />
                {enviando ? "Calculando…" : `Calcular ${seleccion.size} empresa${seleccion.size === 1 ? "" : "s"}`}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="px-5 py-4">
              <div className="flex flex-wrap gap-3 text-[13px]">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-cos-jade-tint px-2.5 py-0.5 font-medium text-cos-jade-ink">
                  <CheckCircle2 className="h-3.5 w-3.5" /> {resultado.creados} creada{resultado.creados === 1 ? "" : "s"}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-cos-slate-tint px-2.5 py-0.5 font-medium text-cos-ink-faint">
                  <MinusCircle className="h-3.5 w-3.5" /> {resultado.omitidos} omitida{resultado.omitidos === 1 ? "" : "s"}
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-cos-red-tint px-2.5 py-0.5 font-medium text-cos-red-ink">
                  <XCircle className="h-3.5 w-3.5" /> {resultado.errores} error{resultado.errores === 1 ? "" : "es"}
                </span>
                {totalWarnings > 0 && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-cos-amber-tint px-2.5 py-0.5 font-medium text-cos-amber-ink">
                    <AlertTriangle className="h-3.5 w-3.5" /> {totalWarnings} advertencia{totalWarnings === 1 ? "" : "s"}
                  </span>
                )}
              </div>

              <div className="mt-3 max-h-[320px] overflow-y-auto rounded-control border border-cos-line">
                {resultado.results.map((r) => (
                  <div key={r.companyId} className="border-b border-cos-line px-3 py-2.5 last:border-b-0">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-cos-ink">{r.razonSocial}</span>
                      {r.runId ? (
                        <span className="inline-flex items-center gap-1 text-[12.5px] text-cos-jade-ink">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Creada · {r.itemCount} empleados · <Money value={r.totalNeto ?? 0} />
                        </span>
                      ) : r.skipped ? (
                        <span className="inline-flex items-center gap-1 text-[12.5px] text-cos-ink-faint">
                          <MinusCircle className="h-3.5 w-3.5" /> Omitida: {r.skipped}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[12.5px] text-cos-red-ink">
                          <XCircle className="h-3.5 w-3.5" /> Error: {r.error}
                        </span>
                      )}
                    </div>
                    {r.warnings?.map((w, i) => (
                      <p key={i} className="mt-1 flex items-start gap-1 text-[11.5px] text-cos-amber-ink">
                        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {w}
                      </p>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-cos-line px-5 py-4">
              <button onClick={onClose} className="rounded-control bg-cos-brand px-4 py-2 text-[13px] font-semibold text-white hover:bg-cos-brand-deep">Cerrar</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
