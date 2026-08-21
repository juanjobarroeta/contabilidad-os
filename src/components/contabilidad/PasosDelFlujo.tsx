"use client";

// ─────────────────────────────────────────────────────────────────────────────
// LOS CINCO PASOS DEL CIERRE, CON SU ESTADO.
//
// Lo que había: cinco <Link> con un número al lado y nada más. El brief pedía
// «listo / pendiente / bloqueado, siempre con el número que importa, NUNCA
// SÓLO UN ÍCONO» — y se entregó menos que ese mínimo. Sin estado, una fila de
// pills es una barra de tabs: hay que entrar a cada paso para saber si ahí hay
// trabajo, que es justo lo que el flujo venía a evitar.
//
// El dato sale de /api/contabilidad/ce-readiness, el MISMO que ya alimenta el
// checklist del tablero. No se calcula nada nuevo aquí: se deja de esconder.
// Así el tablero y el flujo por fin dicen lo mismo en vez de contradecirse.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Check, CircleDashed, Lock, TriangleAlert } from "lucide-react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { estadoDeLosPasos, type ClavePaso, type EstadoPaso } from "@/lib/contabilidad/pasos-cierre";
import type { ReadinessResult } from "@/lib/contabilidad/ce-readiness";
import { cn } from "@/lib/utils";

const PASOS: { clave: ClavePaso; href: string; num: number; label: string }[] = [
  { clave: "cierre", href: "/contabilidad/cierre", num: 1, label: "Cierre" },
  { clave: "conciliacion", href: "/contabilidad/conciliacion", num: 2, label: "Conciliación" },
  { clave: "divergencia", href: "/contabilidad/divergencia", num: 3, label: "Divergencia" },
  { clave: "ajustes", href: "/contabilidad/ajustes", num: 4, label: "Ajustes" },
  { clave: "entregables", href: "/contabilidad/entregables", num: 5, label: "Entregables" },
];

/** Marca y color por estado. `espera` y `sin_datos` van apagados a propósito. */
const PINTA: Record<EstadoPaso["estado"], { Icono: typeof Check; tono: string; marca: string }> = {
  listo:     { Icono: Check,         tono: "text-cos-jade-ink",  marca: "text-cos-jade-ink" },
  atencion:  { Icono: TriangleAlert, tono: "text-cos-amber-ink", marca: "text-cos-amber-ink" },
  bloquea:   { Icono: TriangleAlert, tono: "text-cos-red-ink",   marca: "text-cos-red-ink" },
  espera:    { Icono: Lock,          tono: "text-cos-ink-faint", marca: "text-cos-ink-faint" },
  sin_datos: { Icono: CircleDashed,  tono: "text-cos-ink-faint", marca: "text-cos-ink-faint" },
};

export function PasosDelFlujo() {
  const pathname = usePathname();
  const { activeCompany } = useCompany();
  const { year, month } = usePeriod();
  const [readiness, setReadiness] = useState<ReadinessResult | null>(null);

  const companyId = activeCompany?.id;
  useEffect(() => {
    if (!companyId) return;
    // Al cambiar de empresa o de período, una respuesta en vuelo de la consulta
    // anterior llegaría después y pintaría el estado del período que ya no está
    // en pantalla. La bandera descarta esa respuesta huérfana.
    let vigente = true;
    setReadiness(null);
    fetch(`/api/contabilidad/ce-readiness?companyId=${companyId}&year=${year}&month=${month}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: ReadinessResult | null) => { if (vigente) setReadiness(d); })
      .catch(() => { if (vigente) setReadiness(null); });
    return () => { vigente = false; };
  }, [companyId, year, month]);

  const estados = estadoDeLosPasos(readiness);

  return (
    <nav aria-label="Flujo de cierre" className="flex flex-wrap items-stretch gap-1.5">
      {PASOS.map(({ clave, href, num, label }) => {
        const activo = pathname.startsWith(href);
        const paso = estados.find((e) => e.clave === clave)!;
        const { Icono, tono, marca } = PINTA[paso.estado];
        return (
          <Link
            key={href}
            href={href}
            aria-current={activo ? "page" : undefined}
            className={cn(
              "group flex min-w-[132px] flex-1 flex-col gap-0.5 rounded-card border px-3 py-2 transition-colors",
              activo
                ? "border-cos-brand/40 bg-cos-brand-tint"
                : "border-cos-line bg-cos-card hover:border-cos-brand/30 hover:bg-cos-paper"
            )}
          >
            <span className="flex items-center gap-1.5">
              <Icono className={cn("h-3.5 w-3.5 shrink-0", marca)} strokeWidth={2.4} aria-hidden />
              <span className="font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-cos-ink-faint">
                {num} · {label}
              </span>
            </span>
            {/* EL NÚMERO QUE IMPORTA. Sin él esto vuelve a ser una barra de tabs. */}
            <span className={cn("truncate text-[13px] font-medium leading-tight", tono)}>
              {paso.detalle ?? (readiness === null ? "…" : "Sin datos del periodo")}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
