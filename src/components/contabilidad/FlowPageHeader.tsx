"use client";

// Header de página dentro del flujo de cierre: título 30px + subtítulo con el
// período global y la empresa activa. Mantiene consistencia entre segmentos.

import { ReactNode } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";

export function FlowPageHeader({
  title,
  subtitle,
  context,
  actions,
}: {
  title: string;
  /** Se antepone al "Período · Empresa" por defecto; pasa null para ocultarlo. */
  subtitle?: ReactNode;
  /** Línea de contexto operativo en mono mayúsculas bajo el título (idioma del
   *  deck: «18 RFC · CONSULTA AUTOMÁTICA HOY 06:04»). Hechos, no prosa. */
  context?: ReactNode;
  actions?: ReactNode;
}) {
  const { activeCompany } = useCompany();
  const { label } = usePeriod();
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.03em] text-cos-ink">
          {title}
        </h1>
        {subtitle !== null && (
          <p className="mt-1.5 text-[15px] text-cos-ink-soft">
            {subtitle ?? `${label} · ${activeCompany?.razonSocial ?? ""}`}
          </p>
        )}
        {context && (
          <p className="mt-1 font-mono text-[11px] font-medium uppercase tracking-[0.14em] text-cos-ink-faint">
            {context}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
