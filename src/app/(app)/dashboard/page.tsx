"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import {
  AlertTriangle, Clock, CheckCircle2, CalendarDays,
  ArrowUpRight, ArrowDownLeft, ChevronRight, Sparkles, ShieldQuestion,
  Loader2, KeyRound, SearchX,
} from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Card, Money, Chip, type ChipStatus, Alert, Skeleton, SkeletonCard } from "@/components/ui";
import { WhatsappNudge } from "@/components/whatsapp/WhatsappNudge";
import { PendientesDelCierre } from "@/components/contabilidad/PendientesDelCierre";
import { totalVencido } from "@/lib/obligaciones-monto";

// ── Types (mirrors /api/dashboard) ───────────────────────────────────────────
interface UpcomingOb {
  tipo: string; descripcion: string; periodicidad: string;
  dueDate: string; dueDateFmt: string; periodo: string;
  daysUntil: number; status: "OVERDUE" | "SOON" | "UPCOMING"; filed: boolean;
  /** Pesos a pagar. `null` = no lo sabemos; NO es cero (obligaciones-monto.ts). */
  monto: number | null;
  /** `true` = lo calculamos de los CFDIs, no lo acusó el SAT. */
  montoEstimado: boolean;
  acuseUrl: string | null;
  lineaCaptura: string | null;
  fechaPresentacion: string | null;
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
/**
 * La banda principal: la RESPUESTA del tablero, no un aviso.
 *
 * Antes decía «Tienes 2 obligaciones vencidas — te decimos exactamente cuánto
 * y cómo» y no decía cuánto, ni ligaba a ningún lado. No era descuido: las
 * obligaciones no cargaban importe. Ahora sí (obligaciones-monto.ts), así que
 * la banda encabeza con el número y el botón.
 *
 * Y cuando NO hay nada vencido no queda un hueco: sale EL ENTREGABLE del
 * contador —qué se presentó, cuándo, por cuánto y su acuse—. Un tablero al
 * corriente que sólo dice «no hay nada» se lee como producto sin contenido;
 * uno que enseña el acuse se lee como producto que cumplió.
 */
function BandaPrincipal({
  obligaciones,
  periodoFmt,
}: {
  obligaciones: UpcomingOb[];
  periodoFmt: string;
}) {
  const vencidas = obligaciones.filter((o) => !o.filed && o.status === "OVERDUE");
  const pendientes = obligaciones.filter((o) => !o.filed && o.status !== "OVERDUE");

  if (vencidas.length > 0) {
    const { total, conMonto, sinMonto, algunoEstimado } = totalVencido(vencidas);
    const masVencida = vencidas.reduce((a, b) => (a.daysUntil <= b.daysUntil ? a : b));
    const dias = Math.abs(masVencida.daysUntil);

    return (
      <div className="rounded-card border border-cos-red-tint bg-cos-red-tint/40 px-6 py-[22px]">
        <span className={LBL}>
          Lo que debes de {vencidas.length === 1 ? masVencida.periodo : "periodos vencidos"}
        </span>

        {conMonto > 0 ? (
          <div className="my-2.5 flex flex-wrap items-baseline gap-2.5">
            <Money value={total} size={40} weight={700} />
            {algunoEstimado && (
              <span className="text-[12.5px] text-cos-ink-soft">
                aproximado — calculado de tus CFDIs, aún sin acuse
              </span>
            )}
          </div>
        ) : (
          // Sin importe conocido NO se inventa un cero: se dice qué falta.
          <p className="my-2.5 text-[22px] font-semibold tracking-[-0.02em] text-cos-red-ink">
            {vencidas.length === 1 ? "1 obligación vencida" : `${vencidas.length} obligaciones vencidas`}
            <span className="ml-2 text-[13.5px] font-normal text-cos-ink-soft">
              sin calcular todavía
            </span>
          </p>
        )}

        <p className="text-[14px] font-semibold text-cos-red-ink">
          {dias === 0 ? "Vence hoy" : dias === 1 ? "Venció ayer" : `Venció hace ${dias} días`} · corren
          actualización y recargos (CFF 17-A y 21)
        </p>

        <div className="mt-3.5 flex flex-col gap-1.5 border-t border-cos-red-tint pt-3.5">
          {vencidas.map((o) => (
            <div key={`${o.tipo}-${o.periodo}`} className="flex items-baseline justify-between gap-3 text-[13.5px]">
              <span className="text-cos-ink-soft">
                {o.descripcion} · <span className="text-cos-ink-faint">{o.periodo}</span>
              </span>
              <span className="shrink-0">
                {typeof o.monto === "number" ? (
                  <Money value={o.monto} size={14} weight={600} />
                ) : (
                  <span className="text-cos-ink-faint">sin importe</span>
                )}
              </span>
            </div>
          ))}
          {sinMonto > 0 && conMonto > 0 && (
            <p className="text-[12.5px] text-cos-ink-faint">
              El total no incluye {sinMonto === 1 ? "1 obligación" : `${sinMonto} obligaciones`} sin importe calculado.
            </p>
          )}
        </div>

        <Link
          href="/impuestos"
          className="mt-4 inline-flex items-center gap-1.5 rounded-control bg-cos-brand px-3.5 py-2 text-[13.5px] font-semibold text-white hover:bg-cos-brand-deep"
        >
          Ver cómo presentarlas <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    );
  }

  if (pendientes.length > 0) {
    const masProximo = Math.min(...pendientes.map((o) => o.daysUntil));
    const cuando =
      masProximo === 0 ? "hoy" : masProximo === 1 ? "mañana" : `en ${masProximo} días`;
    return (
      <div className="flex items-center gap-4 rounded-card bg-cos-brand-tint px-6 py-[22px]">
        <div className="grid h-12 w-12 flex-none place-items-center rounded-[14px] bg-cos-brand text-white">
          <Clock className="h-[26px] w-[26px]" strokeWidth={2.2} />
        </div>
        <div className="min-w-0">
          <h2 className="text-[21px] font-semibold tracking-[-0.02em] text-cos-brand-ink">
            Nada vencido en {periodoFmt}
          </h2>
          <p className="mt-1 text-[14.5px] leading-snug text-cos-brand-ink opacity-90">
            Te {pendientes.length === 1 ? "queda 1 trámite" : `quedan ${pendientes.length} trámites`} por
            presentar; el más próximo vence {cuando}.
          </p>
        </div>
      </div>
    );
  }

  // Al corriente. El acuse ES el entregable: se enseña, no se esconde.
  const presentadas = obligaciones.filter((o) => o.filed);
  return (
    <div className="rounded-card border border-cos-jade-tint bg-cos-jade-tint/40 px-6 py-[22px]">
      <div className="flex items-center gap-3">
        <CheckCircle2 className="h-6 w-6 flex-none text-cos-jade-ink" strokeWidth={2.2} />
        <h2 className="text-[21px] font-semibold tracking-[-0.02em] text-cos-jade-ink">
          {periodoFmt} está presentado
        </h2>
      </div>
      {presentadas.length > 0 && (
        <div className="mt-3.5 flex flex-col gap-1.5 border-t border-cos-jade-tint pt-3.5">
          {presentadas.map((o) => (
            <div key={`${o.tipo}-${o.periodo}`} className="flex flex-wrap items-baseline justify-between gap-2 text-[13.5px]">
              <span className="text-cos-ink-soft">
                {o.descripcion} · <span className="text-cos-ink-faint">{o.periodo}</span>
              </span>
              <span className="flex shrink-0 items-baseline gap-3">
                {typeof o.monto === "number" && <Money value={o.monto} size={14} weight={600} />}
                {o.acuseUrl && (
                  <a
                    href={o.acuseUrl}
                    className="font-semibold text-cos-brand-ink hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Acuse ↓
                  </a>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const LBL = "block text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint";

// ── Esqueleto de carga ───────────────────────────────────────────────────────
// Con la forma real del tablero (banda + dos tarjetas + gráfica), no un
// spinner: el layout ya no salta cuando llegan las cifras, y se ve de
// inmediato CUÁNTO va a aparecer.
function InicioSkeleton() {
  // Con la forma REAL del tablero nuevo (banda principal alta + checklist +
  // una tarjeta), no un spinner: el layout ya no salta cuando llegan las
  // cifras. Se actualizó junto con la banda — un esqueleto que dibuja la
  // pantalla anterior es peor que ninguno, porque promete algo que no llega.
  return (
    <div className="space-y-5">
      <div className="rounded-card bg-cos-slate-tint px-6 py-[22px]">
        <Skeleton className="h-3 w-40 bg-cos-line" />
        <Skeleton className="mt-3 h-10 w-56 bg-cos-line" />
        <Skeleton className="mt-3 h-3.5 w-72 bg-cos-line" />
        <div className="mt-4 space-y-2 border-t border-cos-line pt-4">
          <Skeleton className="h-3.5 w-full bg-cos-line" />
          <Skeleton className="h-3.5 w-4/5 bg-cos-line" />
        </div>
      </div>
      <div className="rounded-card border border-cos-line bg-cos-card p-5">
        <Skeleton className="h-3 w-48" />
        <Skeleton className="mt-4 h-1.5 w-full" />
        <Skeleton className="mt-4 h-3.5 w-2/3" />
      </div>
      <SkeletonCard />
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

  // El refresco es silencioso en pantalla, así que un lector de pantalla no se
  // entera cuando las cifras por fin llegan. Anunciamos sólo la transición
  // descargando → listo (no cada tick del intervalo) vía la región aria-live.
  const [aviso, setAviso] = useState("");
  const descargandoPrev = useRef(false);
  useEffect(() => {
    if (descargandoPrev.current && !descargando) {
      setAviso("Tablero actualizado: la descarga de CFDI del SAT terminó.");
    }
    descargandoPrev.current = descargando;
  }, [descargando]);

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
  // Lo VENCIDO ya lo encabeza la banda principal, con su importe y su botón.
  // Repetirlo aquí era la tercera vez que la misma noticia aparecía en la
  // pantalla (banda, este listado, y de refilón en el checklist del cierre),
  // ninguna de las tres con la cifra. Este listado se queda con lo que la
  // banda NO cubre: lo que todavía no vence.
  const proximos = (data?.upcomingObligations ?? []).filter(
    (o) => o.filed || o.status !== "OVERDUE"
  );

  const askAi = () =>
    window.dispatchEvent(new CustomEvent("cos:ask-ai", { detail: { companyId: activeCompany.id } }));

  return (
    <div className="mx-auto max-w-[1000px] px-4 py-6 sm:px-8 sm:py-8">
      {/* Región viva para lectores de pantalla: anuncia cuando el refresco
          silencioso termina de traer los datos del SAT. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {aviso}
      </div>

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
          {/* LA RESPUESTA VA PRIMERO. Los avisos —sincronización, WhatsApp,
              vigencia de la e.firma— son contexto y bajan; antes ocupaban la
              mejor parte de la pantalla y empujaban el número que el usuario
              vino a ver. */}
          <BandaPrincipal
            obligaciones={data.upcomingObligations}
            periodoFmt={data.taxThisMonth.periodoFmt}
          />
          {data.estadoDatos && <EstadoDatosCard estado={data.estadoDatos} />}
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
          {/* Una sola tarjeta: la rejilla de dos columnas se quedó sin su
              pareja al salir "Tu mes en números". */}
          <div className="grid grid-cols-1 gap-4">
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
            {proximos.length === 0 ? (
              <div className="py-6 text-center">
                <CheckCircle2 className="mx-auto mb-2 h-8 w-8 text-cos-jade opacity-70" />
                <p className="text-[13px] text-cos-ink-faint">Sin trámites próximos en 45 días</p>
              </div>
            ) : (
              <div className="flex flex-col">
                {proximos.map((ob) => (
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

          {/* Invitación a conectar WhatsApp: es crecimiento, no cierre. Baja
              junto al asistente en vez de competir con el número del mes. */}
          <WhatsappNudge />

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
