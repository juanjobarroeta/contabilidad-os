"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────────────
// LA TIRA DE PESTAÑAS SUPERIOR — un solo patrón para todas las páginas.
//
// Había tres: la tira de Nómina (arriba, a todo lo ancho, con la línea
// alineada con la del panel del Copiloto), las pestañas de Bancos (debajo del
// título) y las píldoras del Directorio (encima del título). El owner eligió
// la de Nómina; este componente es esa tira, parametrizada.
//
// La tira va ARRIBA del contenedor con padding de la página (a todo lo ancho
// del área de contenido): así su borde inferior corre parejo con el del
// encabezado del Copiloto. `innerClassName` lleva el max-width de la página
// para que las pestañas alineen con el título de abajo.
// ─────────────────────────────────────────────────────────────────────────────

export interface TopTab {
  key: string;
  label: string;
  active: boolean;
  /** Navegación por ruta… */
  href?: string;
  /** …o por estado local de la página. */
  onSelect?: () => void;
  title?: string;
}

const ESTILO_TAB =
  "-mb-px shrink-0 snap-start whitespace-nowrap border-b-2 px-3.5 py-3 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cos-brand-tint";

export function TopTabsBar({
  ariaLabel,
  tabs,
  trailing,
  innerClassName = "max-w-[1000px]",
}: {
  ariaLabel: string;
  tabs: TopTab[];
  /** Acción a la derecha de la tira (p. ej. la liga al cockpit multi-RFC). */
  trailing?: React.ReactNode;
  /** max-width del contenedor interno — el de la columna de contenido. */
  innerClassName?: string;
}) {
  return (
    <div className="border-b border-cos-line px-4 sm:px-8">
      <div className={cn("mx-auto flex items-center gap-1", innerClassName)}>
        <nav
          aria-label={ariaLabel}
          className="flex min-w-0 flex-1 snap-x gap-1 overflow-x-auto"
        >
          {tabs.map((t) => {
            const cls = cn(
              ESTILO_TAB,
              t.active
                ? "border-cos-brand text-cos-brand-ink"
                : "border-transparent text-cos-ink-soft hover:text-cos-ink"
            );
            return t.href ? (
              <Link
                key={t.key}
                href={t.href}
                title={t.title}
                aria-current={t.active ? "page" : undefined}
                className={cls}
              >
                {t.label}
              </Link>
            ) : (
              <button
                key={t.key}
                onClick={t.onSelect}
                title={t.title}
                aria-current={t.active ? "page" : undefined}
                className={cls}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
        {trailing}
      </div>
    </div>
  );
}
