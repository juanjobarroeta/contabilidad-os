"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Shell del flujo de cierre (brief UX: de 10 tabs a un flujo con estado).
// Sostiene el contexto de período y la navegación; cada segmento es su propia
// ruta → code-splitting por paso, deep-links y back/forward gratis.
//
// LOS PASOS LLEVAN ESTADO, y esa es la diferencia entre un flujo y una barra de
// tabs. Antes eran cinco <Link> con un número al lado: había que entrar a cada
// uno para saber si ahí había trabajo. El brief lo pedía explícito —«siempre
// con el número que importa, nunca sólo un ícono»— y se había entregado menos
// que ese mínimo. Ver PasosDelFlujo.
//
// El grupo (flujo) no agrega segmento de URL: /contabilidad/cierre, etc. La
// migración YA terminó: /contabilidad es sólo un redirect que honra los
// deep-links viejos `?tab=`.
// ─────────────────────────────────────────────────────────────────────────────

import { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PeriodProvider, PeriodSelector } from "@/components/contabilidad/PeriodProvider";
import { PasosDelFlujo } from "@/components/contabilidad/PasosDelFlujo";
import { useCompany } from "@/components/layout/CompanyProvider";
import { cn } from "@/lib/utils";

const REPORTES = [
  { href: "/contabilidad/libro", label: "Libro diario" },
  { href: "/contabilidad/balanza", label: "Balanza" },
  { href: "/contabilidad/estado", label: "Estado de resultados" },
  { href: "/contabilidad/balance", label: "Balance general" },
  { href: "/contabilidad/saldos", label: "Saldos interempresa" },
  { href: "/contabilidad/activo-fijo", label: "Activo fijo" },
  { href: "/contabilidad/presentado", label: "Presentado (CE)" },
] as const;

// Tareas que viven fuera del flujo pero pertenecen a la sección.
const TAREAS = [
  { href: "/contabilidad/catalogo", label: "Catálogo y mapeo" },
  { href: "/contabilidad/apertura", label: "Saldos iniciales" },
  { href: "/contabilidad/polizas", label: "Pólizas y auxiliares (XML)" },
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
      <div className="print-report mx-auto max-w-[1100px] px-6 py-7 print:max-w-none print:p-0">
        {/* Los PASOS mandan y van en su propia fila: cada uno carga el número
            que importa (ce-readiness), no sólo su ordinal. Reportes y tareas
            —que no son parte del flujo— bajan a una fila secundaria junto al
            selector de período. */}
        <div className="mb-3 print:hidden">
          <PasosDelFlujo />
        </div>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 print:hidden">
          <nav aria-label="Reportes y tareas" className="flex flex-wrap items-center gap-1">
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
                <div className="my-1 border-t border-cos-line-soft" role="presentation" />
                {TAREAS.map(({ href, label }) => (
                  <Link
                    key={href}
                    href={href}
                    className="block rounded-md px-3 py-1.5 text-[13px] text-cos-ink-soft hover:bg-cos-paper hover:text-cos-ink"
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
