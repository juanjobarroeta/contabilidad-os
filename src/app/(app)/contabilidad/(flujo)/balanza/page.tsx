"use client";

// Balanza de comprobación dentro del flujo de cierre: usa el período global
// y permite el drill-down al auxiliar de cada cuenta.

import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { BalanzaPanel } from "@/components/contabilidad/BalanzaPanel";

export default function BalanzaPage() {
  const { activeCompany } = useCompany();
  const { year, month, setPeriod } = usePeriod();
  if (!activeCompany) return null;
  return (
    <div>
      <FlowPageHeader title="Balanza" />
      <BalanzaPanel companyId={activeCompany.id} year={year} month={month} onChangePeriod={setPeriod} />
    </div>
  );
}
