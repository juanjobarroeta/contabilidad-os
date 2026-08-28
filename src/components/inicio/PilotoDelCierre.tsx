"use client";

// ─────────────────────────────────────────────────────────────────────────────
// LENTE EMPRESA del nuevo Inicio: el Piloto del Cierre (Propuesta B del
// rediseño) — el mes contado como cinco pasos, cada uno con su estado, LA
// CIFRA QUE IMPORTA y una sola acción.
//
// Mata a la banda del «$0.00 vencido»: el paso Declara distingue con
// honestidad importe calculado / por calcular / informativa — nunca más un
// cero en rojo presentado como deuda.
//
// Composición client-side de tres endpoints ya endurecidos (dashboard,
// ce-readiness, nomina/hub) — cero backend nuevo para este lente.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Check, Lock, TriangleAlert } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { Alert, Loading, RetryButton } from "@/components/ui/feedback";
import { Money } from "@/components/ui/Money";
import { cn } from "@/lib/utils";
import type { ReadinessResult } from "@/lib/contabilidad/ce-readiness";

// ── Espejos mínimos de /api/dashboard y /api/nomina/hub ─────────────────────
interface Obligacion {
  descripcion: string;
  dueDateFmt: string;
  daysUntil: number;
  status: "OVERDUE" | "SOON" | "UPCOMING";
  filed: boolean;
  monto: number | null;
  montoEstimado: boolean;
  montoMotivo: "informativa" | "sin_calcular" | null;
}
interface DashboardData {
  estadoDatos: {
    tieneFacturas: boolean;
    sincronizando: boolean;
    ultimaSincronizacion?: string;
    periodosPendientes?: number;
    periodosTotales?: number;
  };
  taxThisMonth: {
    iva: number;
    isr: number | null;
    total: number;
    saldoAFavor: number;
    periodoFmt: string;
    modo: "por_presentar" | "en_curso";
    venceFmt: string;
    diasRestantes: number;
  };
  kpis: {
    ingresosDelMes: number;
    gastosDelMes: number;
    facturasEmitidas: number;
    facturasRecibidas: number;
  };
  totalUnmatched: number;
  upcomingObligations: Obligacion[];
}
interface NominaHub {
  mes: { recibos: number; timbrados: number; neto: number; totalPercepciones: number };
}

type EstadoPaso = "listo" | "atencion" | "bloquea" | "espera";

const PINTA: Record<EstadoPaso, { Icon: typeof Check; clase: string }> = {
  listo: { Icon: Check, clase: "bg-cos-jade-tint text-cos-jade-ink" },
  atencion: { Icon: TriangleAlert, clase: "bg-cos-amber-tint text-cos-amber-ink" },
  bloquea: { Icon: TriangleAlert, clase: "bg-cos-red-tint text-cos-red-ink" },
  espera: { Icon: Lock, clase: "bg-cos-slate-tint text-cos-ink-faint" },
};

function check(r: ReadinessResult | null, clave: string) {
  return r?.checks.find((c) => c.clave === clave) ?? null;
}

/** «hace 5 min / hace 3 h / hace 2 días» — el dato que hace verificable el
 *  paso SAT (decisión del owner: estados con hechos, no eslóganes). */
function hace(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} días`;
}

export function PilotoDelCierre() {
  const { activeCompany } = useCompany();
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [nomina, setNomina] = useState<NominaHub | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const companyId = activeCompany?.id;
  const cargar = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setError(null);
    try {
      const now = new Date();
      const [d, r, n] = await Promise.all([
        fetch(`/api/dashboard?companyId=${companyId}`),
        fetch(`/api/contabilidad/ce-readiness?companyId=${companyId}&year=${now.getFullYear()}&month=${now.getMonth() + 1}`),
        fetch(`/api/nomina/hub?companyId=${companyId}`),
      ]);
      if (!d.ok) throw new Error(`dashboard HTTP ${d.status}`);
      setDash((await d.json()) as DashboardData);
      setReadiness(r.ok ? ((await r.json()) as ReadinessResult) : null);
      setNomina(n.ok ? ((await n.json()) as NominaHub) : null);
    } catch {
      setDash(null);
      setError("No se pudo cargar el piloto del mes.");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (!activeCompany) return null;
  if (error) {
    return (
      <Alert tone="danger" action={<RetryButton onClick={cargar} />}>
        {error}
      </Alert>
    );
  }
  if (loading || !dash) return <Loading label="Armando el piloto del mes…" />;

  // ── Paso 1 · SAT ──
  const ed = dash.estadoDatos;
  const satEstado: EstadoPaso = ed.sincronizando || !ed.tieneFacturas ? "atencion" : "listo";

  // ── Paso 2 · Bancos ──
  const sinClasificar = check(readiness, "sin_clasificar");
  const banco = check(readiness, "banco");
  const bancoRojo = [sinClasificar, banco].some((c) => c?.estado === "error");
  const bancoEstado: EstadoPaso = bancoRojo ? "bloquea" : dash.totalUnmatched > 0 ? "atencion" : "listo";

  // ── Paso 3 · Nómina ──
  const sinTimbrar = nomina ? nomina.mes.recibos - nomina.mes.timbrados : 0;
  const nominaEstado: EstadoPaso = sinTimbrar > 0 ? "atencion" : "listo";

  // ── Paso 4 · Declara — la banda honesta ──
  const vencidas = dash.upcomingObligations.filter((o) => !o.filed && o.status === "OVERDUE");
  const conMonto = vencidas.filter((o) => o.monto !== null);
  const sinMonto = vencidas.filter((o) => o.monto === null && o.montoMotivo !== "informativa");
  const informativas = vencidas.filter((o) => o.montoMotivo === "informativa");
  const totalVencido = conMonto.reduce((t, o) => t + (o.monto ?? 0), 0);
  const algunoEstimado = conMonto.some((o) => o.montoEstimado);
  const declaraEstado: EstadoPaso = vencidas.length > 0 ? "bloquea" : "atencion";
  const tax = dash.taxThisMonth;

  // ── Paso 5 · Cierre ──
  const posteo = check(readiness, "posteo");
  const cuadre = check(readiness, "cuadre");
  const cierreBloqueado = bancoEstado === "bloquea";
  const cierreEstado: EstadoPaso = cierreBloqueado
    ? "espera"
    : posteo?.estado === "ok" && cuadre?.estado === "ok"
      ? "listo"
      : "atencion";

  const pasos: {
    num: number;
    titulo: string;
    sub: string;
    estado: EstadoPaso;
    cuerpo: ReactNode;
    cta: { label: string; href: string };
  }[] = [
    // Subtítulos = ESTADOS con hechos, no eslóganes (decisión del owner en la
    // revisión página por página): el usuario quiere leer qué pasa, no que le
    // vendan el producto que ya compró.
    {
      num: 1,
      titulo: "SAT",
      sub: ed.sincronizando
        ? "Sincronizando con el SAT…"
        : ed.ultimaSincronizacion
          ? `Última sincronización ${hace(ed.ultimaSincronizacion)}`
          : ed.tieneFacturas
            ? "CFDIs cargados"
            : "Sin facturas sincronizadas todavía",
      estado: satEstado,
      cuerpo: (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Cifra label="Facturaste" valor={<Money value={dash.kpis.ingresosDelMes} weight={700} />} />
          <Cifra label="Te facturaron" valor={<Money value={dash.kpis.gastosDelMes} weight={700} />} />
          <Cifra label="CFDIs emitidos" valor={dash.kpis.facturasEmitidas} />
          <Cifra label="CFDIs recibidos" valor={dash.kpis.facturasRecibidas} />
        </div>
      ),
      cta: { label: "Ver facturas", href: "/facturas" },
    },
    {
      num: 2,
      titulo: "Bancos",
      sub:
        dash.totalUnmatched > 0
          ? `${dash.totalUnmatched} movimiento${dash.totalUnmatched === 1 ? "" : "s"} por clasificar`
          : "Banco conciliado y clasificado",
      estado: bancoEstado,
      cuerpo:
        dash.totalUnmatched > 0 ? (
          <p className="text-[13.5px] text-cos-ink-soft">
            {sinClasificar?.detalle ?? banco?.detalle ?? "La mesa los agrupa por parecido."}
          </p>
        ) : (
          <p className="text-[13.5px] text-cos-jade-ink">Todo conciliado o clasificado.</p>
        ),
      cta: { label: dash.totalUnmatched > 0 ? `Revisar en la mesa` : "Abrir bancos", href: "/bancos" },
    },
    {
      num: 3,
      titulo: "Nómina",
      sub: sinTimbrar > 0
        ? `${sinTimbrar} recibo${sinTimbrar === 1 ? "" : "s"} por timbrar`
        : "Nómina timbrada al corriente",
      estado: nominaEstado,
      cuerpo: nomina ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Cifra label="Recibos del mes" valor={nomina.mes.recibos} />
          <Cifra
            label="Sin timbrar"
            valor={sinTimbrar}
            tono={sinTimbrar > 0 ? "amber" : undefined}
          />
          <Cifra label="Neto del mes" valor={<Money value={nomina.mes.neto} weight={700} />} />
        </div>
      ) : (
        <p className="text-[13.5px] text-cos-ink-soft">Sin datos de nómina este mes.</p>
      ),
      cta: { label: sinTimbrar > 0 ? "Timbrar" : "Abrir nómina", href: "/nomina" },
    },
    {
      num: 4,
      titulo: "Declara",
      sub:
        vencidas.length > 0
          ? `${vencidas.length} obligación${vencidas.length === 1 ? "" : "es"} vencida${vencidas.length === 1 ? "" : "s"}`
          : `Declaración de ${tax.periodoFmt}`,
      estado: declaraEstado,
      cuerpo:
        vencidas.length > 0 ? (
          <div>
            {conMonto.length > 0 ? (
              <div>
                <p className="flex flex-wrap items-baseline gap-2 text-[15px] text-cos-ink">
                  <Money value={totalVencido} size={26} weight={700} className="text-cos-red-ink" />
                  {/* El titular no puede subestimar la deuda: lo que falta por
                      calcular se declara junto al importe (decisión del owner). */}
                  {sinMonto.length > 0 && (
                    <span className="text-[15px] font-semibold text-cos-red-ink">
                      + {sinMonto.length} por calcular
                    </span>
                  )}
                </p>
                {algunoEstimado && (
                  <p className="text-[12px] text-cos-ink-soft">
                    aproximado — calculado de tus CFDIs, aún sin acuse
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[14px] font-medium text-cos-red-ink">
                {sinMonto.length + informativas.length} obligación
                {vencidas.length === 1 ? "" : "es"} vencida{vencidas.length === 1 ? "" : "s"} — importe
                por calcular
              </p>
            )}
            <ul className="mt-2 space-y-1">
              {vencidas.slice(0, 4).map((o, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <span className="text-cos-ink-soft">
                    {o.descripcion} · venció {o.dueDateFmt} ({Math.abs(o.daysUntil)} día
                    {Math.abs(o.daysUntil) === 1 ? "" : "s"})
                  </span>
                  <span className="shrink-0 font-medium text-cos-ink">
                    {o.monto !== null ? (
                      <Money value={o.monto} size={12} />
                    ) : o.montoMotivo === "informativa" ? (
                      "informativa"
                    ) : (
                      "por calcular"
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11.5px] text-cos-red-ink">
              Corren actualización y recargos (CFF 17-A y 21).
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Cifra label="IVA" valor={<Money value={tax.iva} weight={700} />} />
            <Cifra label="ISR" valor={tax.isr !== null ? <Money value={tax.isr} weight={700} /> : "—"} />
            <Cifra
              label={tax.modo === "por_presentar" ? "Vence" : "Corte al día"}
              valor={`${tax.venceFmt}`}
              sub={tax.diasRestantes > 0 ? `en ${tax.diasRestantes} días` : undefined}
            />
            <Cifra
              label="Saldo a favor"
              valor={<Money value={tax.saldoAFavor} weight={700} />}
              tono={tax.saldoAFavor > 0 ? "jade" : undefined}
            />
          </div>
        ),
      cta: { label: vencidas.length > 0 ? "Presentar ahora" : "Preparar presentación", href: "/impuestos" },
    },
    {
      num: 5,
      titulo: "Cierre",
      sub: cierreBloqueado
        ? "En espera del banco"
        : posteo?.estado === "ok"
          ? "Mes posteado — Anexo 24 disponible"
          : "Mes preliminar, sin postear",
      estado: cierreEstado,
      cuerpo: (
        <p className="text-[13.5px] text-cos-ink-soft">
          {cierreBloqueado
            ? "El cierre espera a que el banco quede clasificado."
            : (posteo?.estado === "ok"
                ? "Mes posteado — entregables del Anexo 24 disponibles."
                : posteo?.detalle ?? "El mes aún no se ha posteado.")}
        </p>
      ),
      cta: { label: "Ir al cierre", href: "/contabilidad/cierre" },
    },
  ];

  // El momento dorado del contador: nada vencido, banco limpio, nómina
  // timbrada y mes posteado. Merece celebrarse, no cinco tarjetas mudas.
  const todoAlDia =
    satEstado === "listo" &&
    bancoEstado === "listo" &&
    nominaEstado === "listo" &&
    vencidas.length === 0 &&
    cierreEstado === "listo";

  return (
    <ol className="space-y-3">
      {todoAlDia && (
        <li className="flex items-center gap-3 rounded-card border border-cos-jade-ink/25 bg-cos-jade-tint px-5 py-4">
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-cos-jade text-white">
            <Check className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[16px] font-semibold text-cos-jade-ink">Todo al día</p>
            <p className="text-[13px] text-cos-ink-soft">
              Sin vencidos, banco conciliado, nómina timbrada y mes posteado — entregables listos.
            </p>
          </div>
        </li>
      )}
      {pasos.map((p) => {
        const pinta = PINTA[p.estado];
        return (
          <li key={p.num} className="rounded-card border border-cos-line bg-cos-card px-5 py-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-3">
                <span className={cn("flex h-7 w-7 items-center justify-center rounded-full", pinta.clase)}>
                  {p.estado === "listo" ? <Check className="h-4 w-4" /> : <pinta.Icon className="h-4 w-4" />}
                </span>
                <div>
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.13em] text-cos-ink-faint">
                    Paso {p.num} · {p.titulo}
                  </p>
                  <p className="text-[15px] font-semibold text-cos-ink">{p.sub}</p>
                </div>
              </div>
              <Link
                href={p.cta.href}
                className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-paper px-3 py-1.5 text-[12.5px] font-semibold text-cos-ink hover:border-cos-brand/50 hover:bg-cos-brand-tint"
              >
                {p.cta.label} <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            {p.cuerpo}
          </li>
        );
      })}
    </ol>
  );
}

function Cifra({
  label,
  valor,
  sub,
  tono,
}: {
  label: string;
  valor: ReactNode;
  sub?: string;
  tono?: "jade" | "amber";
}) {
  return (
    <div>
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-cos-ink-faint">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 text-[16px] font-semibold tabular-nums",
          tono === "jade" ? "text-cos-jade-ink" : tono === "amber" ? "text-cos-amber-ink" : "text-cos-ink",
        )}
      >
        {valor}
      </p>
      {sub && <p className="text-[11px] text-cos-ink-soft">{sub}</p>}
    </div>
  );
}
