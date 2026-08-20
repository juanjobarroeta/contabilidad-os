"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Shell del flujo de cierre (brief UX: de 10 tabs a 6 módulos con flujo).
// Sostiene el contexto de período y la navegación del flujo; cada segmento
// (cierre, conciliación, divergencia, ajustes, entregables, reportes) es su
// propia ruta → code-splitting por paso, deep-links y back/forward gratis.
//
// El grupo (flujo) no agrega segmento de URL: /contabilidad/cierre, etc.
// La página vieja /contabilidad?tab= queda intacta fuera del grupo hasta
// terminar la migración.
// ─────────────────────────────────────────────────────────────────────────────

import { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PeriodProvider, PeriodSelector } from "@/components/contabilidad/PeriodProvider";
import { useCompany } from "@/components/layout/CompanyProvider";
import { cn } from "@/lib/utils";

const PASOS = [
  { href: "/contabilidad/cierre", num: 1, label: "Cierre" },
  { href: "/contabilidad/conciliacion", num: 2, label: "Conciliación" },
  { href: "/contabilidad/divergencia", num: 3, label: "Divergencia" },
  { href: "/contabilidad/ajustes", num: 4, label: "Ajustes" },
  { href: "/contabilidad/entregables", num: 5, label: "Entregables" },
] as const;

const REPORTES = [
  { href: "/contabilidad/libro", label: "Libro diario" },
  { href: "/contabilidad/balanza", label: "Balanza" },
  { href: "/contabilidad/estado", label: "Estado de resultados" },
  { href: "/contabilidad/balance", label: "Balance general" },
  { href: "/contabilidad/saldos", label: "Saldos interempresa" },
  { href: "/contabilidad/activo-fijo", label: "Activo fijo" },
  { href: "/contabilidad/presentado", label: "Presentado (CE)" },
] as const;

export default function FlujoLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { activeCompany } = useCompany();

  if (!activeCompany) {
    return (
      <div className="p-8 text-cos-ink-soft text-sm">
        Selecciona una empresa para ver su contabilidad.
      </div>
    );
  }

  const enReporte = REPORTES.some((r) => pathname.startsWith(r.href));

  return (
    <PeriodProvider>
      <div className="mx-auto max-w-[1100px] px-6 py-7">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <nav aria-label="Flujo de cierre" className="flex flex-wrap items-center gap-1">
            {PASOS.map(({ href, num, label }) => {
              const activo = pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  aria-current={activo ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors",
                    activo
                      ? "bg-cos-brand-tint text-cos-brand-ink"
                      : "text-cos-ink-soft hover:bg-cos-paper hover:text-cos-ink"
                  )}
                >
                  <span
                    className={cn(
                      "font-mono text-[11px]",
                      activo ? "text-cos-brand-ink" : "text-cos-ink-faint"
                    )}
                  >
                    {num}
                  </span>
                  {label}
                </Link>
              );
            })}
            <span className="mx-1 h-4 w-px bg-cos-line" aria-hidden />
            <details className="relative" open={enReporte ? true : undefined}>
              <summary
                className={cn(
                  "inline-flex cursor-pointer list-none items-center gap-1 rounded-full px-3 py-1.5 text-[13px] font-medium [&::-webkit-details-marker]:hidden",
                  enReporte
                    ? "bg-cos-slate-tint text-cos-ink"
                    : "text-cos-ink-soft hover:bg-cos-paper hover:text-cos-ink"
                )}
              >
                Reportes ▾
              </summary>
              <div className="absolute left-0 top-full z-20 mt-1 w-56 rounded-card border border-cos-line bg-cos-card p-1 shadow-card">
                {REPORTES.map(({ href, label }) => (
                  <Link
                    key={href}
                    href={href}
                    className={cn(
                      "block rounded-md px-3 py-1.5 text-[13px]",
                      pathname.startsWith(href)
                        ? "bg-cos-brand-tint text-cos-brand-ink font-medium"
                        : "text-cos-ink-soft hover:bg-cos-paper hover:text-cos-ink"
                    )}
                  >
                    {label}
                  </Link>
                ))}
              </div>
            </details>
          </nav>
          <PeriodSelector />
        </div>
        {children}
      </div>
    </PeriodProvider>
  );
}
