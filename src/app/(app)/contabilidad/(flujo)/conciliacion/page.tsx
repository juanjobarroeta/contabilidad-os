"use client";

// Paso 2 del flujo: la conciliación bancaria es COMPUERTA del cierre — el
// motor no postea un mes con movimientos sin conciliar (regla existente).

import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { ConciliacionBancariaPanel } from "@/components/contabilidad/ConciliacionBancariaPanel";

export default function ConciliacionPage() {
  const { activeCompany } = useCompany();
  const { year, month } = usePeriod();
  if (!activeCompany) return null;
  return (
    <div>
      <FlowPageHeader title="Conciliación bancaria" />
      <ConciliacionBancariaPanel companyId={activeCompany.id} year={year} month={month} />
    </div>
  );
}
