"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  AlertTriangle, Clock, CheckCircle2, CalendarDays,
  ArrowUpRight, ArrowDownLeft, ChevronRight, Sparkles, ShieldQuestion,
  Loader2, KeyRound, SearchX, ClipboardCheck,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card, Money, Chip, type ChipStatus, Alert, Skeleton, SkeletonCard } from "@/components/ui";
import { WhatsappNudge } from "@/components/whatsapp/WhatsappNudge";
import { PendientesDelCierre } from "@/components/contabilidad/PendientesDelCierre";

// ── Types (mirrors /api/dashboard) ───────────────────────────────────────────
interface TrendPoint { label: string; periodo: string; ingresos: number; gastos: number }
interface UpcomingOb {
  tipo: string; descripcion: string; periodicidad: string;
  dueDate: string; dueDateFmt: string; periodo: string;
  daysUntil: number; status: "OVERDUE" | "SOON" | "UPCOMING"; filed: boolean;
}
interface EstadoDatos {
  tieneFacturas: boolean;
  fielConfigurada: boolean;
  sincronizando: boolean;
  sinResultados: boolean;
  periodosPendientes?: number;
  periodosTotales?: number;
  ultimaSincronizacion?: string;
}
interface DashboardData {
  periodo: { year: number; month: number };
  fiel: { estado: "ok" | "por_vencer" | "vencida" | "sin_fiel"; vigencia: string | null; diasRestantes: number | null } | null;
  estadoDatos?: EstadoDatos;
  apertura?: { confirmada: boolean; nudge: boolean };
  taxThisMonth: {
    iva: number; isr: number | null; total: number; saldoAFavor: number;
    /** Período fiscal EN JUEGO (no necesariamente el mes calendario). */
    periodo: string; periodoFmt: string; modo: "por_presentar" | "en_curso";
    vence: string; venceFmt: string; diasRestantes: number; tarifaVerificada: boolean;
    coeficiente?: number | null;
    coeficienteSugerido?: number | null;
    coeficienteSugeridoFuente?: "declaracion_anual" | "provisional_previo" | "calculado" | "ninguno" | null;
  };
  asimilados: {
    mes: { ingreso: number; isrRetenido: number };
    anual: { ingreso: number; isrRetenido: number };
  } | null;
  kpis: {
    ingresosDelMes: number; gastosDelMes: number; utilidadBruta: number;
    facturasEmitidas: number; facturasRecibidas: number;
  };
  trend: TrendPoint[];
  upcomingObligations: UpcomingOb[];
}

const MONTHS = [
  "Enero","Febrero","Marzo","Abril","Mayo","Junio",
  "Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre",
];

/** Strip the legal-entity suffix for a friendlier short name in the greeting. */
function shortName(razonSocial: string): string {
  return razonSocial
    .replace(/\s*,?\s*S\.?\s*A\.?\s*P\.?\s*I\.?\s*(\s*DE\s*)?C\.?\s*V\.?$/i, "")
    .replace(/\s*,?\s*S\.?\s*(DE\s*)?R\.?\s*L\.?\s*(\s*DE\s*)?C\.?\s*V\.?$/i, "")
    .replace(/\s*,?\s*S\.?\s*A\.?\s*(\s*DE\s*)?C\.?\s*V\.?$/i, "")
    .replace(/\s*,?\s*S\.?\s*C\.?$/i, "")
    .replace(/\s*,?\s*S\.?\s*A\.?$/i, "")
    .trim() || razonSocial;
}

// Map the API obligation state → the shared Chip status vocabulary.
function obChip(ob: UpcomingOb): ChipStatus {
  if (ob.filed) return "presentada";
  if (ob.status === "OVERDUE") return "vencida";
  if (ob.status === "SOON") return "porvencer";
  return "pendiente";
}

// ── 6-month bars (ingresos jade / gastos red) ─────────────────────────────────
function MiniBars({ trend }: { trend: TrendPoint[] }) {
  const max = Math.max(...trend.flatMap((t) => [t.ingresos, t.gastos]), 1);
  return (
    <div className="flex items-end gap-2.5 h-[150px] pt-2.5">
      {trend.map((t) => (
        <div key={t.periodo} className="flex-1 flex flex-col items-center gap-2 h-full">
          <div className="flex-1 w-full flex items-end justify-center gap-[5px]">
            <div
              className="w-[38%] max-w-[22px] rounded-t-[5px] bg-cos-jade min-h-[3px]"
              style={{ height: `${(t.ingresos / max) * 100}%` }}
              title={`Ingresos ${t.ingresos.toLocaleString("en-US")}`}
            />
            <div
              className="w-[38%] max-w-[22px] rounded-t-[5px] bg-[oklch(0.78_0.13_25)] min-h-[3px]"
              style={{ height: `${(t.gastos / max) * 100}%` }}
              title={`Gastos ${t.gastos.toLocaleString("en-US")}`}
            />
          </div>
          <span className="font-mono text-[11.5px] text-cos-ink-faint">{t.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Estado de datos: tarjeta "tablero vacío" tras el onboarding ───────────────
// Explica por qué no hay cifras todavía: descarga del SAT en curso, e.firma
// pendiente de configurar, o descarga terminada sin CFDIs encontrados.
function fmtUltimaSync(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("es-MX", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function EstadoDatosCard({ estado }: { estado: EstadoDatos }) {
  if (estado.tieneFacturas) return null;

  // Sin e.firma no hay descarga automática posible: nudge hacia /empresa.
  if (!estado.fielConfigurada) {
    return (
      <div className="flex items-start gap-4 rounded-card bg-cos-amber-tint px-6 py-[22px]">
        <div className="grid h-12 w-12 flex-none place-items-center rounded-[14px] bg-cos-amber text-white">
          <KeyRound className="h-[26px] w-[26px]" strokeWidth={2.2} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[21px] font-semibold tracking-[-0.02em] text-cos-amber-ink">
            Falta tu e.firma para traer tus facturas
          </h2>
          <p className="mt-1 text-[14.5px] leading-snug text-cos-amber-ink opacity-90">
            Sin la e.firma (FIEL) no podemos descargar tus CFDI del SAT automáticamente,
            por eso el tablero está en ceros. Configúrala una sola vez y nosotros nos
            encargamos del resto.
          </p>
          <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link
              href="/empresa"
              className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3.5 py-2 text-[13.5px] font-semibold text-white hover:bg-cos-brand-deep"
            >
              Configurar e.firma <ChevronRight className="h-3.5 w-3.5" />
            </Link>
            <span className="text-[12.5px] text-cos-amber-ink opacity-80">
              Mientras tanto, puedes subir tus estados de cuenta en{" "}
              <Link href="/bancos" className="font-semibold underline">Bancos</Link>.
            </span>
          </div>
        </div>
      </div>
    );
  }

  // Descarga en curso: progreso por períodos + última sincronización.
  if (estado.sincronizando) {
    const totales = estado.periodosTotales ?? 0;
    const pendientes = estado.periodosPendientes ?? 0;
    const completados = Math.max(totales - pendientes, 0);
    const ultima = fmtUltimaSync(estado.ultimaSincronizacion);
    return (
      <div className="flex items-start gap-4 rounded-card bg-cos-brand-tint px-6 py-[22px]">
        <div className="grid h-12 w-12 flex-none place-items-center rounded-[14px] bg-cos-brand text-white">
          <Loader2 className="h-[26px] w-[26px] animate-spin" strokeWidth={2.2} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[21px] font-semibold tracking-[-0.02em] text-cos-brand-ink">
            Estamos descargando tus CFDI del SAT
          </h2>
          <p className="mt-1 text-[14.5px] leading-snug text-cos-brand-ink opacity-90">
            La descarga puede tardar desde unos minutos hasta varias horas — depende de
            los tiempos del SAT. Puedes seguir usando la plataforma; el tablero se irá
            llenando conforme lleguen tus facturas.
          </p>
          {totales > 0 && (
            <div className="mt-3.5">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/70">
                <div
                  className="h-full rounded-full bg-cos-brand transition-all duration-700"
                  style={{ width: `${Math.round((completados / totales) * 100)}%` }}
                />
              </div>
            </div>
          )}
          <p className="mt-2 text-[12.5px] text-cos-brand-ink opacity-75">
            {totales > 0 && `${completados} de ${totales} períodos descargados`}
            {totales > 0 && ultima && " · "}
            {ultima && `Última actualización: ${ultima}`}
            {(totales > 0 || ultima) && " · "}
            Esta página se actualiza sola cada minuto.
          </p>
        </div>
      </div>
    );
  }

  // Descarga terminada sin CFDIs: no girar para siempre — explicar y dar salidas.
  if (estado.sinResultados) {
    return (
      <div className="flex items-start gap-4 rounded-card border border-cos-line bg-white px-6 py-[22px] shadow-card">
        <div className="grid h-12 w-12 flex-none place-items-center rounded-[14px] bg-cos-slate-tint text-cos-ink-soft">
          <SearchX className="h-[26px] w-[26px]" strokeWidth={2.2} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[21px] font-semibold tracking-[-0.02em] text-cos-ink">
            No encontramos CFDI en el SAT
          </h2>
          <p className="mt-1 text-[14.5px] leading-snug text-cos-ink-soft">
            La descarga terminó, pero el SAT no devolvió facturas para los períodos
            consultados. Si tu empresa es de reciente creación, esto es normal — el
            tablero se llenará conforme factures. También puedes revisar los períodos en{" "}
            <Link href="/impuestos?tab=del-mes" className="font-semibold text-cos-brand-ink underline">Impuestos</Link>{" "}
            o subir tus estados de cuenta en{" "}
            <Link href="/bancos" className="font-semibold text-cos-brand-ink underline">Bancos</Link>.
          </p>
        </div>
      </div>
    );
  }

  return null;
}

// ── Apertura fiscal: nudge de revisión del punto de partida ───────────────────
// Aparece cuando ya hay con qué revisar (e.firma + descarga histórica lista) y
// el contador aún no ha confirmado la apertura. Un dato inicial erróneo se
// hereda a todos los meses, así que este aviso empuja a revisarlo UNA vez.
function AperturaNudgeCard() {
  return (
    <div className="flex items-start gap-4 rounded-card bg-cos-amber-tint px-6 py-[22px]">
      <div className="grid h-12 w-12 flex-none place-items-center rounded-[14px] bg-cos-amber text-white">
        <ClipboardCheck className="h-[26px] w-[26px]" strokeWidth={2.2} />
      </div>
      <div className="min-w-0 flex-1">
        <h2 className="text-[21px] font-semibold tracking-[-0.02em] text-cos-amber-ink">
          Revisa y confirma tu punto de partida fiscal
        </h2>
        <p className="mt-1 text-[14.5px] leading-snug text-cos-amber-ink opacity-90">
          Tus datos del SAT ya están descargados. Antes de confiar en los cálculos, revisa el
          saldo a favor de IVA inicial, las pérdidas por amortizar, el coeficiente de utilidad y
          las obligaciones: un error en el arranque se arrastra a todos los meses.
        </p>
        <div className="mt-3.5">
          <Link
            href="/empresa/apertura"
            className="inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3.5 py-2 text-[13.5px] font-semibold text-white hover:bg-cos-brand-deep"
          >
            Revisar punto de partida <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}

// ── Hero status band ──────────────────────────────────────────────────────────
function HeroBand({ obligaciones }: { obligaciones: UpcomingOb[] }) {
  const vencidas = obligaciones.filter((o) => !o.filed && o.status === "OVERDUE").length;
  const pendientes = obligaciones.filter((o) => !o.filed && o.status !== "OVERDUE").length;

  let tone: "red" | "blue" | "jade";
  let Icon = CheckCircle2;
  let title: string;
  let body: string;

  if (vencidas > 0) {
    tone = "red"; Icon = AlertTriangle;
    title = vencidas === 1 ? "Tienes 1 obligación vencida" : `Tienes ${vencidas} obligaciones vencidas`;
    body = "Preséntala lo antes posible para evitar recargos. Te decimos exactamente cuánto y cómo.";
  } else if (pendientes > 0) {
    // "Nada urgente" sólo si de verdad no urge: con un vencimiento a ≤7 días
    // el tono cambia (el caso típico: las mensuales de junio vencen el 17 de
    // julio y el tablero decía "tienes tiempo").
    const masProximo = Math.min(
      ...obligaciones.filter((o) => !o.filed && o.status !== "OVERDUE").map((o) => o.daysUntil)
    );
    tone = "blue"; Icon = Clock;
    title = "Casi listo este mes";
    body =
      masProximo <= 7
        ? `Te queda ${pendientes === 1 ? "1 trámite" : `${pendientes} trámites`} por presentar. El más próximo vence ${
            masProximo === 0 ? "hoy" : masProximo === 1 ? "mañana" : `en ${masProximo} días`
          }.`
        : `Te queda ${pendientes === 1 ? "1 trámite" : `${pendientes} trámites`} por presentar. Nada urgente — tienes tiempo.`;
  } else {
    tone = "jade"; Icon = CheckCircle2;
    title = "Vas al día";
    body = "Todas tus obligaciones de este mes están presentadas. No tienes que hacer nada.";
  }

  const band = {
    red: "bg-cos-red-tint",
    blue: "bg-cos-brand-tint",
    jade: "bg-cos-jade-tint",
  }[tone];
  const tile = {
    red: "bg-cos-red",
    blue: "bg-cos-brand",
    jade: "bg-cos-jade",
  }[tone];
  const ink = {
    red: "text-cos-red-ink",
    blue: "text-cos-brand-ink",
    jade: "text-cos-jade-ink",
  }[tone];

  return (
    <div className={`flex items-center gap-4 rounded-card px-6 py-[22px] ${band}`}>
      <div className={`grid h-12 w-12 flex-none place-items-center rounded-[14px] text-white ${tile}`}>
        <Icon className="h-[26px] w-[26px]" strokeWidth={2.2} />
      </div>
      <div>
        <h2 className={`text-[21px] font-semibold tracking-[-0.02em] ${ink}`}>{title}</h2>
        <p className={`mt-1 text-[14.5px] leading-snug ${ink} opacity-90`}>{body}</p>
      </div>
    </div>
  );
}

const LBL = "block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint";

// ── Esqueleto de carga ───────────────────────────────────────────────────────
// Con la forma real del tablero (banda + dos tarjetas + gráfica), no un
// spinner: el layout ya no salta cuando llegan las cifras, y se ve de
// inmediato CUÁNTO va a aparecer.
function InicioSkeleton() {
  return (
    <div className="space-y-5">
      <div className="rounded-card bg-cos-slate-tint px-6 py-[22px]">
        <div className="flex items-center gap-4">
          <Skeleton className="h-12 w-12 flex-none rounded-[14px] bg-cos-line" />
          <div className="flex-1">
            <Skeleton className="h-5 w-64 bg-cos-line" />
            <Skeleton className="mt-2 h-3.5 w-80 bg-cos-line" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SkeletonCard />
        <SkeletonCard />
      </div>
      <div className="rounded-card border border-cos-line bg-cos-card p-5">
        <Skeleton className="h-3 w-40" />
        <div className="mt-5 flex h-[150px] items-end gap-2.5">
          {[55, 80, 40, 95, 65, 75].map((h, i) => (
            <Skeleton key={i} className="flex-1 rounded-t-[5px]" style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function InicioPage() {
  const { activeCompany, loading: companyLoading } = useCompany();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const fetchDashboard = useCallback(async (silent = false) => {
    if (!activeCompany) return;
    if (!silent) {
      setLoading(true);
      setError("");
    }
    try {
      const res = await fetch(`/api/dashboard?companyId=${activeCompany.id}`);
      if (!res.ok) throw new Error();
      setData(await res.json());
    } catch {
      // En refrescos silenciosos no pisamos la vista con un error transitorio.
      if (!silent) setError("No se pudo cargar el inicio");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [activeCompany]);

  useEffect(() => { fetchDashboard(); }, [fetchDashboard]);

  // Mientras el SAT descarga los CFDI de una empresa recién creada, refrescamos
  // en silencio cada 60 s. Se detiene solo: al llegar facturas, al terminar la
  // descarga o al desmontar la página.
  const descargando =
    !!data?.estadoDatos && !data.estadoDatos.tieneFacturas && data.estadoDatos.sincronizando;
  useEffect(() => {
    if (!descargando) return;
    const id = setInterval(() => fetchDashboard(true), 60_000);
    return () => clearInterval(id);
  }, [descargando, fetchDashboard]);

  if (companyLoading) return <div className="p-8 text-sm text-cos-ink-faint">Cargando…</div>;

  if (!activeCompany) {
    return (
      <div className="mx-auto mt-20 max-w-md p-8 text-center">
        <h2 className="text-lg font-semibold text-cos-ink">No hay empresas registradas</h2>
        <p className="mt-2 text-sm text-cos-ink-soft">Agrega tu primera empresa para comenzar.</p>
        <Link href="/onboarding" className="mt-4 inline-block rounded-control bg-cos-brand px-4 py-2 text-sm font-semibold text-white hover:bg-cos-brand-deep">
          Agregar empresa
        </Link>
      </div>
    );
  }

  const { year, month } = data?.periodo ?? { year: new Date().getFullYear(), month: new Date().getMonth() + 1 };
  const mesLabel = `${MONTHS[month - 1]} ${year}`;

  // "Ask AI" — forward-compatible hook the AI panel will listen for once wired.
  const askAi = () =>
    window.dispatchEvent(new CustomEvent("cos:ask-ai", { detail: { companyId: activeCompany.id } }));

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-8 sm:py-8">
      {/* greeting */}
      <div className="mb-[18px]">
        <p className="text-[15px] text-cos-ink-faint">Hola, esto es lo importante de</p>
        <h1 className="mt-0.5 text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">
          {shortName(activeCompany.razonSocial)}
        </h1>
        <p className="mt-1.5 text-[14px] text-cos-ink-soft">
          <span className="font-mono">{activeCompany.rfc}</span> · {mesLabel}
        </p>
      </div>

      {error && (
        <Alert tone="danger" className="mb-4 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />{error}
        </Alert>
      )}

      {loading || !data ? (
        <InicioSkeleton />
      ) : (
        <div className="space-y-5">
          {data.estadoDatos && <EstadoDatosCard estado={data.estadoDatos} />}
          {data.apertura?.nudge && <AperturaNudgeCard />}
          <WhatsappNudge />
          {data.fiel && (data.fiel.estado === "vencida" || data.fiel.estado === "por_vencer") && (
            <div className={`flex items-center gap-3 rounded-card px-5 py-3.5 text-[14px] ${data.fiel.estado === "vencida" ? "bg-cos-red-tint text-cos-red-ink" : "bg-cos-amber-tint text-cos-amber-ink"}`}>
              <AlertTriangle className="h-5 w-5 flex-none" />
              <span>
                {data.fiel.estado === "vencida"
                  ? "Tu e.firma (FIEL) está vencida — la sincronización con el SAT está detenida. Renuévala en el SAT y vuelve a subirla."
                  : `Tu e.firma (FIEL) vence en ${data.fiel.diasRestantes} día${data.fiel.diasRestantes === 1 ? "" : "s"}. Renuévala antes de que caduque para no interrumpir la sincronización de CFDIs.`}
              </span>
            </div>
          )}
          <HeroBand obligaciones={data.upcomingObligations} />

          {/* El checklist del cierre, justo debajo del estado con el SAT: la
              banda dice cómo vas, esto dice qué te falta hacer. Se omite
              mientras el tablero está vacío — ahí la tarjeta de estado de datos
              ya explica que la descarga del SAT sigue en curso, y listar
              "sin CFDIs del periodo" como pendiente sólo repetiría el mismo
              mensaje con otras palabras. */}
          {data.estadoDatos?.tieneFacturas !== false && (
            <PendientesDelCierre
              companyId={activeCompany.id}
              periodo={data.taxThisMonth.periodo}
              periodoFmt={data.taxThisMonth.periodoFmt}
            />
          )}

          {/* cuánto debo + mes en números */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="rounded-card border-cos-line p-5 shadow-card">
              {/* El período fiscal en juego puede diferir del mes calendario:
                  del 1 al ~17 se trabaja (y se muestra) el mes anterior. */}
              <div className="flex items-center justify-between gap-2">
                <span className={LBL}>¿Cuánto debo? · {data.taxThisMonth.periodoFmt}</span>
                {data.taxThisMonth.modo === "en_curso" && (
                  <span className="rounded-full bg-cos-slate-tint px-2 py-0.5 text-[11px] font-medium text-cos-ink-soft">
                    Mes en curso · va acumulando
                  </span>
                )}
              </div>
              <div className="my-2.5">
                <Money value={data.taxThisMonth.total} size={40} weight={700} />
              </div>
              <div className="flex flex-col gap-2 border-y border-cos-line-soft py-3.5">
                <div className="flex items-center justify-between gap-3 text-[14px] text-cos-ink-soft">
                  <span className="whitespace-nowrap">IVA mensual</span>
                  <Money value={data.taxThisMonth.iva} size={15} weight={500} muted />
                </div>
                <div className="flex items-center justify-between gap-3 text-[14px] text-cos-ink-soft">
                  <span className="whitespace-nowrap">ISR (anticipo)</span>
                  {data.taxThisMonth.isr == null ? (
                    <span className="font-mono text-[15px] text-cos-ink-faint">—</span>
                  ) : (
                    <Money value={data.taxThisMonth.isr} size={15} weight={500} muted />
                  )}
                </div>
              </div>
              <div className="mt-3.5 flex items-center justify-between">
                <span
                  className={`inline-flex items-center gap-1.5 text-[13.5px] ${
                    data.taxThisMonth.diasRestantes < 0
                      ? "font-semibold text-cos-red-ink"
                      : data.taxThisMonth.diasRestantes <= 7 && data.taxThisMonth.modo === "por_presentar"
                        ? "font-semibold text-cos-amber-ink"
                        : "text-cos-ink-soft"
                  }`}
                >
                  <CalendarDays className="h-[15px] w-[15px]" />
                  {data.taxThisMonth.diasRestantes < 0
                    ? `Venció el ${data.taxThisMonth.venceFmt}`
                    : `Vence el ${data.taxThisMonth.venceFmt}`}
                </span>
                <Link href="/impuestos?tab=del-mes" className="inline-flex items-center gap-1 rounded-control px-2 py-1.5 text-[13px] font-semibold text-cos-brand-ink hover:bg-cos-brand-tint">
                  Ver detalle <ChevronRight className="h-3.5 w-3.5" />
                </Link>
              </div>
              {!data.taxThisMonth.tarifaVerificada && (
                <p className="mt-2 text-[12px] text-cos-amber-ink">
                  Tarifa ISR sin verificar contra Anexo 8 — cifra provisional.
                </p>
              )}
              {data.taxThisMonth.coeficienteSugerido != null &&
                (data.taxThisMonth.coeficiente == null ||
                  Math.abs(data.taxThisMonth.coeficienteSugerido - data.taxThisMonth.coeficiente) > 0.0005) && (
                  <p className="mt-2 text-[12px] text-cos-amber-ink">
                    Coeficiente sugerido {(data.taxThisMonth.coeficienteSugerido * 100).toFixed(2)}%
                    {data.taxThisMonth.coeficiente != null &&
                      ` (aplicas ${(data.taxThisMonth.coeficiente * 100).toFixed(2)}%)`}{" "}
                    — <Link href="/impuestos?tab=del-mes" className="underline">ajústalo</Link>.
                  </p>
                )}
            </Card>

            <Card className="rounded-card border-cos-line p-5 shadow-card">
              <span className={LBL}>Tu mes en números</span>
              <div className="mt-3.5 grid grid-cols-1 gap-3.5 min-[768px]:grid-cols-3">
                <div className="flex flex-row items-baseline justify-between gap-2 min-[768px]:flex-col min-[768px]:items-start min-[768px]:justify-start min-[768px]:gap-1">
                  <span className="inline-flex items-center gap-1 whitespace-nowrap text-[12.5px] font-medium text-cos-ink-faint">
                    <ArrowUpRight className="h-3.5 w-3.5" /> Te pagaron
                  </span>
                  <Money value={data.kpis.ingresosDelMes} size={16} />
                  <span className="text-[12px] text-cos-ink-faint">
                    {data.kpis.facturasEmitidas} factura{data.kpis.facturasEmitidas === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="flex flex-row items-baseline justify-between gap-2 min-[768px]:flex-col min-[768px]:items-start min-[768px]:justify-start min-[768px]:gap-1">
                  <span className="inline-flex items-center gap-1 whitespace-nowrap text-[12.5px] font-medium text-cos-ink-faint">
                    <ArrowDownLeft className="h-3.5 w-3.5" /> Gastaste
                  </span>
                  <Money value={data.kpis.gastosDelMes} size={16} />
                  <span className="text-[12px] text-cos-ink-faint">
                    {data.kpis.facturasRecibidas} factura{data.kpis.facturasRecibidas === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="flex flex-row items-baseline justify-between gap-2 min-[768px]:flex-col min-[768px]:items-start min-[768px]:justify-start min-[768px]:gap-1">
                  <span className="text-[12.5px] font-medium text-cos-ink-faint">Te queda</span>
                  {data.taxThisMonth.isr == null ? (
                    <>
                      <Money value={data.kpis.utilidadBruta} size={16} sign />
                      <span className="text-[12px] text-cos-ink-faint">antes de impuestos</span>
                    </>
                  ) : (
                    <>
                      <Money value={data.kpis.utilidadBruta - data.taxThisMonth.isr} size={16} sign />
                      <span className="text-[12px] text-cos-ink-faint">después de ISR</span>
                    </>
                  )}
                </div>
              </div>
              {/* Impuestos que genera la actividad de este mes (motor fiscal real). */}
              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-cos-line-soft pt-3.5">
                <span className="text-[12.5px] font-medium text-cos-ink-faint">Impuestos de este mes</span>
                <span className="inline-flex items-baseline gap-1.5 text-[12.5px] text-cos-ink-soft">
                  IVA <Money value={data.taxThisMonth.iva} size={14} weight={600} />
                </span>
                <span className="inline-flex items-baseline gap-1.5 text-[12.5px] text-cos-ink-soft">
                  ISR{" "}
                  {data.taxThisMonth.isr == null
                    ? <span className="font-semibold text-cos-ink-faint">—</span>
                    : <Money value={data.taxThisMonth.isr} size={14} weight={600} />}
                </span>
                <span className="ml-auto text-[12px] text-cos-ink-faint">se pagan el {data.taxThisMonth.venceFmt}</span>
              </div>
            </Card>

          </div>

          {/* asimilados a salarios — se reconoce solo, sólo si la empresa recibe */}
          {data.asimilados && (
            <Card className="rounded-card border-cos-line p-5 shadow-card">
              <span className={LBL}>Asimilados a salarios</span>
              <div className="mt-3.5 grid grid-cols-1 gap-3.5 min-[768px]:grid-cols-3">
                <div>
                  <p className="text-[12.5px] text-cos-ink-faint">Ingresos del mes</p>
                  <Money value={data.asimilados.mes.ingreso} size={16} />
                </div>
                <div>
                  <p className="text-[12.5px] text-cos-ink-faint">ISR que te retuvieron (pago provisional)</p>
                  <Money value={data.asimilados.mes.isrRetenido} size={16} />
                </div>
                <div>
                  <p className="text-[12.5px] text-cos-ink-faint">ISR que te retuvieron en {data.periodo.year} (acreditable)</p>
                  <Money value={data.asimilados.anual.isrRetenido} size={16} />
                </div>
              </div>
              <p className="mt-3 text-[12.5px] text-cos-ink-faint">
                Art. 94: el pagador retiene y entera el ISR — se acredita en tu declaración anual.
              </p>
            </Card>
          )}

          {/* obligaciones */}
          <Card className="rounded-card border-cos-line p-5 shadow-card">
            <div className="mb-3.5 flex items-start justify-between gap-3">
              <span className={LBL}>Próximos trámites con el SAT</span>
              <Link href="/impuestos?tab=del-mes" className="rounded-control px-2 py-1.5 text-[13px] font-semibold text-cos-brand-ink hover:bg-cos-brand-tint">
                Ver todos
              </Link>
            </div>
            {data.upcomingObligations.length === 0 ? (
              <div className="py-6 text-center">
                <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-cos-jade opacity-70" />
                <p className="text-[13px] text-cos-ink-faint">Sin trámites próximos en 45 días</p>
              </div>
            ) : (
              <div className="flex flex-col">
                {data.upcomingObligations.map((ob) => (
                  <div key={ob.tipo} className="flex items-center justify-between gap-3.5 border-t border-cos-line-soft py-3.5 first:border-t-0">
                    <div className="min-w-0">
                      <p className="text-[15px] font-semibold text-cos-ink">{ob.descripcion}</p>
                      <p className="mt-0.5 text-[13px] text-cos-ink-soft">
                        {ob.periodo} · vence {ob.dueDateFmt}
                      </p>
                    </div>
                    <div className="flex flex-none flex-col items-end gap-1.5">
                      <Chip status={obChip(ob)} />
                      <span className="text-[12px] text-cos-ink-faint">
                        {ob.filed ? "listo" : ob.status === "OVERDUE" ? `venció ${ob.dueDateFmt}` : `${ob.daysUntil}d`}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* trend */}
          <Card className="rounded-card border-cos-line p-5 shadow-card">
            <div className="mb-1 flex items-start justify-between gap-3">
              <div>
                <span className={LBL}>Cómo te ha ido</span>
                <p className="mt-1 text-[13px] text-cos-ink-soft">Últimos 6 meses · sin IVA</p>
              </div>
              <div className="flex gap-3.5 text-[12.5px] text-cos-ink-soft">
                <span className="inline-flex items-center gap-1.5"><i className="h-[9px] w-[9px] rounded-[3px] bg-cos-jade" /> Ingresos</span>
                <span className="inline-flex items-center gap-1.5"><i className="h-[9px] w-[9px] rounded-[3px] bg-cos-red" /> Gastos</span>
              </div>
            </div>
            {data.trend.every((t) => t.ingresos === 0 && t.gastos === 0) ? (
              <div className="flex h-[150px] items-center justify-center">
                <div className="text-center">
                  <p className="text-sm text-cos-ink-soft">Sin facturas en los últimos 6 meses</p>
                  <Link href="/impuestos?tab=del-mes" className="mt-1 inline-block text-xs text-cos-brand-ink hover:underline">
                    Importar CFDIs del SAT →
                  </Link>
                </div>
              </div>
            ) : (
              <MiniBars trend={data.trend} />
            )}
            <div className="mt-3.5 grid grid-cols-1 gap-3 border-t border-cos-line-soft pt-3.5 min-[768px]:grid-cols-3">
              <div className="flex flex-row items-baseline justify-between gap-2 min-[768px]:flex-col min-[768px]:items-start min-[768px]:gap-0.5">
                <span className="text-[12px] text-cos-ink-faint">Ingresos 6m</span>
                <Money value={data.trend.reduce((s, t) => s + t.ingresos, 0)} size={16} />
              </div>
              <div className="flex flex-row items-baseline justify-between gap-2 min-[768px]:flex-col min-[768px]:items-start min-[768px]:gap-0.5">
                <span className="text-[12px] text-cos-ink-faint">Gastos 6m</span>
                <Money value={data.trend.reduce((s, t) => s + t.gastos, 0)} size={16} />
              </div>
              <div className="flex flex-row items-baseline justify-between gap-2 min-[768px]:flex-col min-[768px]:items-start min-[768px]:gap-0.5">
                <span className="text-[12px] text-cos-ink-faint">Te quedó</span>
                <Money value={data.trend.reduce((s, t) => s + t.ingresos - t.gastos, 0)} size={16} sign />
              </div>
            </div>
          </Card>

          {/* ask AI */}
          <button
            onClick={askAi}
            className="flex w-full items-center gap-3.5 rounded-card border border-dashed border-cos-brand/35 bg-cos-brand-tint px-[18px] py-[15px] text-left text-[14px] text-cos-brand-ink hover:border-cos-brand"
          >
            <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-cos-brand text-white">
              <Sparkles className="h-[18px] w-[18px]" />
            </span>
            <span className="flex-1">
              ¿Tienes dudas? Pregúntale al asistente — “¿por qué debo este IVA?”, “¿qué pasa si no presento la DIOT?”
            </span>
            <ShieldQuestion className="h-4 w-4 flex-none opacity-60" />
          </button>
        </div>
      )}
    </div>
  );
}
