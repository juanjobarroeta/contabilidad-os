"use client";

import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { LibroDiarioPanel } from "@/components/contabilidad/LibroPanels";

export default function LibroPage() {
  const { activeCompany } = useCompany();
  const { year, month } = usePeriod();
  if (!activeCompany) return null;
  return (
    <div>
      <FlowPageHeader title="Libro diario" />
      <LibroDiarioPanel companyId={activeCompany.id} year={year} month={month} />
    </div>
  );
}
