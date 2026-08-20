"use client";

// Estado de resultados dentro del flujo de cierre: usa el período global.

import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { EstadoResultadosPanel } from "@/components/contabilidad/EstadoResultadosPanel";

export default function EstadoPage() {
  const { activeCompany } = useCompany();
  const { year, month, setPeriod } = usePeriod();
  if (!activeCompany) return null;
  return (
    <div>
      <FlowPageHeader title="Estado de resultados" />
      <EstadoResultadosPanel companyId={activeCompany.id} year={year} month={month} onChangePeriod={setPeriod} />
    </div>
  );
}
