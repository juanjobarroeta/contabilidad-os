"use client";

import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { BalanceGeneralPanel } from "@/components/contabilidad/LibroPanels";

export default function BalancePage() {
  const { activeCompany } = useCompany();
  const { year, month } = usePeriod();
  if (!activeCompany) return null;
  return (
    <div>
      <FlowPageHeader title="Balance general" />
      <BalanceGeneralPanel companyId={activeCompany.id} year={year} month={month} />
    </div>
  );
}
