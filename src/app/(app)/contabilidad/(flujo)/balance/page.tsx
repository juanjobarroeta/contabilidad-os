"use client";

import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { BotonImprimir, PrintHeader } from "@/components/contabilidad/PrintHeader";
import { BalanceGeneralPanel } from "@/components/contabilidad/LibroPanels";

export default function BalancePage() {
  const { activeCompany } = useCompany();
  const { year, month } = usePeriod();
  if (!activeCompany) return null;
  return (
    <div>
      <PrintHeader title="Balance general" />
      {/* El encabezado de pantalla no va al papel: PrintHeader lo sustituye. */}
      <div className="print:hidden">
        <FlowPageHeader title="Balance general" actions={<BotonImprimir />} />
      </div>
      <BalanceGeneralPanel companyId={activeCompany.id} year={year} month={month} />
    </div>
  );
}
