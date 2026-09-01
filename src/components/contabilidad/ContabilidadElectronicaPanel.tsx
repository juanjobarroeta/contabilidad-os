"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle, ArrowRight, BookOpen, CheckCircle2, Clock, Download,
  ExternalLink, FileCheck2, FileText, Landmark, Loader2, ShieldCheck,
} from "lucide-react";
import { MESES } from "@/components/contabilidad/PeriodProvider";
import Link from "next/link";
import { useDescargaXml, ErroresDeValidacion } from "@/components/contabilidad/descarga-xml";

// ── Readiness CE (tipos espejo de /api/contabilidad/ce-readiness) ──────────────
export type ReadinessCheckEstado = "ok" | "warn" | "error";
export type ReadinessStatus = "lista" | "con_huecos" | "incompleta";
export interface ReadinessCheck {
  clave: string;
  estado: ReadinessCheckEstado;
  titulo: string;
  detalle: string;
  cta?: { label: string; href: string };
}
export interface ReadinessResult {
  status: ReadinessStatus;
  resumen: string;
  checks: ReadinessCheck[];
}

// ── Periodos (compartido con la página de contabilidad) ────────────────────────
export type PeriodStatus = "DRAFT" | "POSTED" | "CLOSED";
export interface Period {
  id: string;
  year: number;
  month: number;
  status: PeriodStatus;
  postedAt: string | null;
  entriesCount: number;
  totalCargos: number;
  totalAbonos: number;
}

// ── Contabilidad Electrónica ───────────────────────────────────────────────────
// Consolida los entregables que el SAT pide cada mes (Anexo 24), generados
// AUTOMÁTICAMENTE desde la contabilidad viva de la empresa: catálogo de cuentas,
// balanza de comprobación y pólizas. No hay ensamblado manual ni carga de XML:
// el contador abre el periodo y los XML están listos para descargar.
export function ContabilidadElectronicaPanel({
  companyId, periods, year, month,
}: {
  companyId: string;
  periods: Period[];
  year: number;
  month: number;
}) {
  const qs = `companyId=${companyId}&year=${year}&month=${month}`;

  // Readiness: ¿es confiable la CE de este periodo y qué falta si no?
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setReadinessLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/contabilidad/ce-readiness?${qs}`);
        const data = await res.json();
        if (!cancelled && res.ok) setReadiness(data as ReadinessResult);
        else if (!cancelled) setReadiness(null);
      } catch {
        if (!cancelled) setReadiness(null);
      } finally {
        if (!cancelled) setReadinessLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [qs]);

  const { descargar, descargando, error: errorDescarga } = useDescargaXml();
  // Compuerta espejo del servidor: un mes sin postear responde 422 en
  // balanza/pólizas/auxiliares — mejor deshabilitar con la razón aquí que
  // dejar que el click choque contra el candado.
  const mesSinPostear = readiness != null &&
    readiness.checks.find((c) => c.clave === "posteo")?.estado !== "ok";

  const entregables: {
    key: string;
    label: string;
    desc: string;
    Icon: typeof BookOpen;
    href?: string;
    note?: string;
  }[] = [
    {
      key: "catalogo",
      label: "Catálogo de cuentas",
      desc: "Estructura de cuentas con su código agrupador del SAT. Se genera desde tu catálogo.",
      Icon: BookOpen,
      href: `/api/contabilidad/coe/catalogo?${qs}`,
    },
    {
      key: "balanza",
      label: "Balanza de comprobación",
      desc: "Saldos y movimientos del mes. Se genera desde tu balanza mensual (normal o complementaria automática).",
      Icon: FileCheck2,
      href: `/api/contabilidad/coe/balanza?${qs}`,
    },
    {
      key: "polizas",
      label: "Pólizas del periodo",
      desc: "Pólizas con sus auxiliares. El SAT las solicita en auditoría, devolución o compensación; requiere el folio del requerimiento.",
      Icon: FileText,
      href: `/contabilidad/polizas`,
      note: "requiere folio",
    },
  ];

  return (
    <div>
      {/* El período se elige en la navegación del flujo (‹ mes ›): un picker
          local aquí era un SEGUNDO control para lo mismo en la misma pantalla. */}
      {/* ¿Lista tu Contabilidad Electrónica? — readiness del periodo */}
      <ReadinessCard
        loading={readinessLoading}
        readiness={readiness}
        mesLabel={`${MESES[month - 1]} ${year}`}
      />

      {/* La entrega completa en un archivo. Antes había que bajar cada pieza de
          su propia pantalla y armar la carpeta a mano, mes por mes. */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-card border border-cos-brand/30 bg-cos-brand-tint px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-cos-ink">Paquete del mes</p>
          <p className="text-[13px] text-cos-ink-soft">
            Los XML del SAT, los estados financieros en Excel y la DIOT en un solo zip, con un
            LEEME que dice qué trae y qué falta.
          </p>
        </div>
        <button
          type="button"
          onClick={() => descargar(`/api/contabilidad/paquete?${qs}`)}
          disabled={descargando !== null}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-control bg-cos-brand px-3 py-2 text-[13px] font-medium text-white hover:bg-cos-brand-deep disabled:opacity-60"
        >
          {descargando?.includes("/paquete") ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}{" "}
          Descargar paquete
        </button>
      </div>

      <ErroresDeValidacion error={errorDescarga} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {entregables.map(({ key, label, desc, Icon, href, note }) => (
          <div key={key} className="flex flex-col rounded-card border border-cos-line bg-cos-card p-4">
            <div className="mb-2 flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-control bg-cos-slate-tint text-cos-ink-soft">
                <Icon className="h-4 w-4" />
              </span>
              <p className="text-sm font-semibold text-cos-ink">{label}</p>
            </div>
            <p className="mb-4 flex-1 text-[13px] leading-snug text-cos-ink-soft">{desc}</p>
            {key === "polizas" ? (
              <a
                href={href}
                className="inline-flex items-center justify-center gap-1.5 rounded-control border border-cos-line bg-cos-paper px-3 py-2 text-[13px] font-medium text-cos-ink hover:bg-cos-slate-tint"
              >
                Abrir pólizas y auxiliares <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : (
              <button
                type="button"
                onClick={() => href && descargar(href)}
                disabled={descargando !== null || (key === "balanza" && mesSinPostear)}
                className="inline-flex items-center justify-center gap-1.5 rounded-control bg-cos-brand px-3 py-2 text-[13px] font-medium text-white hover:bg-cos-brand-deep disabled:cursor-not-allowed disabled:opacity-50"
              >
                {descargando === href ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}{" "}
                Descargar XML
              </button>
            )}
            {key === "balanza" && mesSinPostear && (
              <p className="mt-2 text-[11px] text-cos-amber-ink">
                El mes no está contabilizado — contabilízalo en{" "}
                <Link href="/contabilidad/cierre" className="underline">Cierre del mes</Link>{" "}
                para generar la balanza definitiva.
              </p>
            )}
            {note && <p className="mt-2 text-[11px] text-cos-ink-faint">{note}</p>}
          </div>
        ))}
      </div>

      {/* Seguimiento: envío automático con e.firma (pendiente) */}
      <div className="mt-4 flex items-start gap-2 rounded-card border border-dashed border-cos-line px-4 py-3 text-[13px] text-cos-ink-soft">
        <Landmark className="h-4 w-4 shrink-0 mt-0.5 text-cos-ink-faint" />
        <span>
          El envío automático al SAT con tu e.firma está en camino. Por ahora descarga los XML y
          cárgalos en el portal del SAT; pronto lo haremos por ti.
        </span>
      </div>
    </div>
  );
}

// ── Tarjeta de readiness CE ─────────────────────────────────────────────────────
// Resumen claro de si la CE del periodo es confiable y, si no, qué falta. Verde
// = lista; ámbar = con huecos; rojo = incompleta. Lista los checks con su CTA.
function ReadinessCard({
  loading, readiness, mesLabel,
}: { loading: boolean; readiness: ReadinessResult | null; mesLabel: string }) {
  if (loading) {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-card border border-cos-line bg-cos-card px-4 py-3 text-sm text-cos-ink-soft">
        <Loader2 className="h-4 w-4 animate-spin" /> Revisando si tu Contabilidad Electrónica está lista…
      </div>
    );
  }
  if (!readiness) {
    return (
      <div className="mb-4 flex items-start gap-2 rounded-card border border-cos-line bg-cos-slate-tint px-4 py-3 text-sm text-cos-ink">
        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-cos-ink-soft" />
        <span>No se pudo evaluar el estado de preparación de la CE de {mesLabel}.</span>
      </div>
    );
  }

  const { status, resumen, checks } = readiness;

  // Tema por estado global (sólo tokens cos-*).
  const tema = {
    lista: {
      wrap: "border-[oklch(0.66_0.12_168_/_0.28)] bg-cos-jade-tint",
      head: "text-cos-jade-ink",
      Icon: ShieldCheck,
      titulo: "Lista para el SAT",
    },
    con_huecos: {
      wrap: "border-cos-amber bg-cos-amber-tint",
      head: "text-cos-amber-ink",
      Icon: AlertCircle,
      titulo: "Casi lista",
    },
    incompleta: {
      wrap: "border-[oklch(0.6_0.2_25_/_0.22)] bg-cos-red-tint",
      head: "text-cos-red-ink",
      Icon: AlertCircle,
      titulo: "Incompleta",
    },
  }[status];

  const iconoCheck: Record<ReadinessCheckEstado, React.ReactNode> = {
    ok: <CheckCircle2 className="h-4 w-4 shrink-0 text-cos-jade-ink" />,
    warn: <Clock className="h-4 w-4 shrink-0 text-cos-amber-ink" />,
    error: <AlertCircle className="h-4 w-4 shrink-0 text-cos-red-ink" />,
  };

  return (
    <div className={`mb-5 rounded-card border ${tema.wrap}`}>
      <div className="flex items-start gap-2.5 px-4 py-3">
        <tema.Icon className={`h-5 w-5 shrink-0 mt-0.5 ${tema.head}`} />
        <div className="min-w-0">
          <p className={`text-[15px] font-semibold ${tema.head}`}>{tema.titulo} — {mesLabel}</p>
          <p className="mt-0.5 text-[13px] text-cos-ink-soft">{resumen}</p>
        </div>
      </div>

      <div className="border-t border-cos-line-soft bg-cos-card/60 px-4 py-3">
        <ul className="flex flex-col gap-2.5">
          {checks.map((c) => (
            <li key={c.clave} className="flex items-start gap-2.5">
              {iconoCheck[c.estado]}
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-medium text-cos-ink">{c.titulo}</p>
                <p className="text-[12.5px] leading-snug text-cos-ink-soft">{c.detalle}</p>
              </div>
              {c.cta && (
                <a
                  href={c.cta.href}
                  className="inline-flex flex-none items-center gap-1 rounded-control border border-cos-line bg-cos-card px-2.5 py-1.5 text-[12px] font-semibold text-cos-brand-ink hover:bg-cos-paper"
                >
                  {c.cta.label} <ArrowRight className="h-3 w-3" />
                </a>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
