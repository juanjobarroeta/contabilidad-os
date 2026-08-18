"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle2, ChevronRight, ListChecks } from "lucide-react";
import { Card, Chip, SkeletonRows } from "@/components/ui";
import { resumirCierre, type ResumenCierre } from "@/lib/contabilidad/cierre-resumen";
import type { ReadinessResult } from "@/lib/contabilidad/ce-readiness";

/**
 * "Pendientes del cierre" — el checklist vivo del mes en el tablero.
 *
 * El tablero ya dice cuánto debes y qué trámites vienen, pero no lo que
 * realmente te detiene: el TRABAJO DE CIERRE. Ese diagnóstico ya existía
 * completo en `ce-readiness` y sólo se veía enterrado en el panel de CE, en una
 * pantalla a la que se llega a propósito. Aquí sale a la portada, que es donde
 * un contador decide qué hacer hoy.
 *
 * Dos decisiones de diseño que importan:
 *
 *   • Se listan SÓLO los pendientes. Lo que ya está en verde se cuenta como
 *     progreso ("4 de 6 listos") en vez de ocupar un renglón — una lista de
 *     palomas no dice qué hacer a continuación.
 *   • Cada renglón lleva su número y su liga directa. "43 movimientos sin
 *     clasificar → Bancos" es accionable; "conciliación pendiente" no lo es.
 *
 * El periodo es el FISCAL EN JUEGO (el que el tablero ya usa para "cuánto
 * debo"), no el mes calendario: en agosto se cierra julio.
 */

type Estado = "cargando" | "listo" | "error";

export function PendientesDelCierre({
  companyId,
  periodo,
  periodoFmt,
}: {
  /** Empresa activa. */
  companyId: string;
  /** Periodo fiscal en juego, `YYYY-MM`. */
  periodo: string;
  /** El mismo periodo en texto ("Julio 2026"), para el encabezado. */
  periodoFmt: string;
}) {
  const [estado, setEstado] = useState<Estado>("cargando");
  const [resumen, setResumen] = useState<ResumenCierre | null>(null);

  useEffect(() => {
    const [y, m] = periodo.split("-");
    if (!y || !m) {
      setEstado("error");
      return;
    }

    // Al cambiar de empresa o de periodo, una respuesta en vuelo de la consulta
    // anterior llegaría después y pintaría los pendientes de la empresa que ya
    // no está en pantalla. La bandera descarta esa respuesta huérfana.
    let vigente = true;
    setEstado("cargando");

    fetch(`/api/contabilidad/ce-readiness?companyId=${companyId}&year=${y}&month=${m}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: ReadinessResult) => {
        if (!vigente) return;
        setResumen(resumirCierre(data));
        setEstado("listo");
      })
      .catch(() => {
        if (vigente) setEstado("error");
      });

    return () => {
      vigente = false;
    };
  }, [companyId, periodo]);

  // Una tarjeta secundaria que falla no debe romper el tablero, pero tampoco
  // desaparecer en silencio: quien la vio ayer notaría el hueco sin saber por qué.
  if (estado === "error") {
    return (
      <Card className="rounded-card border-cos-line p-5 shadow-card">
        <Encabezado periodoFmt={periodoFmt} />
        <p className="mt-3 text-[13px] text-cos-ink-soft">
          No se pudo cargar el estado del cierre.
        </p>
      </Card>
    );
  }

  if (estado === "cargando" || !resumen) {
    return (
      <Card className="rounded-card border-cos-line p-5 shadow-card">
        <Encabezado periodoFmt={periodoFmt} />
        <SkeletonRows rows={3} className="mt-3 divide-y-0" />
      </Card>
    );
  }

  const { pendientes, listos, total, bloqueantes, todoListo } = resumen;

  return (
    <Card className="rounded-card border-cos-line p-5 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <Encabezado periodoFmt={periodoFmt} />
        <Link
          href="/contabilidad"
          className="shrink-0 rounded-control px-2 py-1.5 text-[13px] font-semibold text-cos-brand-ink hover:bg-cos-brand-tint"
        >
          Ver contabilidad
        </Link>
      </div>

      <Progreso listos={listos} total={total} todoListo={todoListo} />

      {todoListo ? (
        <div className="mt-4 flex items-start gap-3 rounded-card bg-cos-jade-tint px-4 py-3.5">
          <CheckCircle2 className="mt-0.5 h-5 w-5 flex-none text-cos-jade-ink" strokeWidth={2.2} />
          <div className="min-w-0">
            <p className="text-[14.5px] font-semibold text-cos-jade-ink">
              Todo listo para cerrar {periodoFmt}
            </p>
            <p className="mt-0.5 text-[13px] leading-snug text-cos-jade-ink opacity-90">
              No queda nada por resolver: los CFDIs, el banco y la balanza del periodo están en orden.
            </p>
          </div>
        </div>
      ) : (
        <ul className="mt-4 space-y-1.5">
          {pendientes.map((c) => (
            <li key={c.clave}>
              <Pendiente
                estado={c.estado}
                titulo={c.titulo}
                detalle={c.detalle}
                cta={c.cta}
              />
            </li>
          ))}
        </ul>
      )}

      {bloqueantes > 0 && (
        <p className="mt-3 text-[12.5px] text-cos-ink-faint">
          {bloqueantes === 1
            ? "1 pendiente impide cerrar el mes; el resto sólo resta precisión."
            : `${bloqueantes} pendientes impiden cerrar el mes; el resto sólo resta precisión.`}
        </p>
      )}
    </Card>
  );
}

function Encabezado({ periodoFmt }: { periodoFmt: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium uppercase tracking-[0.02em] text-cos-ink-faint">
      <ListChecks className="h-4 w-4" />
      Pendientes del cierre · {periodoFmt}
    </span>
  );
}

/** "4 de 6 listos" + barra. El progreso es el único lugar donde vive lo ya hecho. */
function Progreso({
  listos,
  total,
  todoListo,
}: {
  listos: number;
  total: number;
  todoListo: boolean;
}) {
  const pct = total > 0 ? Math.round((listos / total) * 100) : 0;
  return (
    <div className="mt-3 flex items-center gap-3">
      <div
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-cos-slate-tint"
        role="progressbar"
        aria-valuenow={listos}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label="Avance del cierre"
      >
        <div
          className={`h-full rounded-full transition-[width] ${todoListo ? "bg-cos-jade" : "bg-cos-brand"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 font-mono text-[12px] text-cos-ink-faint">
        {listos} de {total} listos
      </span>
    </div>
  );
}

function Pendiente({
  estado,
  titulo,
  detalle,
  cta,
}: {
  estado: "warn" | "error" | "ok";
  titulo: string;
  detalle: string;
  cta?: { label: string; href: string };
}) {
  const bloquea = estado === "error";

  const contenido = (
    <>
      {/* Barra de color: el estado se lee antes que el texto al barrer la lista. */}
      <span
        aria-hidden
        className={`w-1 flex-none self-stretch rounded-full ${bloquea ? "bg-cos-red" : "bg-cos-amber"}`}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-[14px] font-semibold text-cos-ink">{titulo}</p>
          {bloquea && <Chip tone="red" label="Bloquea" />}
        </div>
        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-cos-ink-soft">{detalle}</p>
      </div>
      {cta && (
        <span className="mt-0.5 inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap text-[13px] font-semibold text-cos-brand-ink">
          {cta.label}
          <ChevronRight className="h-3.5 w-3.5" />
        </span>
      )}
    </>
  );

  // Sin CTA no hay a dónde ir: se pinta igual pero no finge ser un enlace.
  if (!cta) {
    return <div className="flex items-start gap-3 rounded-card px-2 py-2.5">{contenido}</div>;
  }

  return (
    <Link
      href={cta.href}
      className="flex items-start gap-3 rounded-card px-2 py-2.5 transition-colors hover:bg-cos-paper"
    >
      {contenido}
    </Link>
  );
}
