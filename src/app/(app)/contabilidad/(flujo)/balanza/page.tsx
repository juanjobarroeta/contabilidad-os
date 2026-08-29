"use client";

// Balanza de comprobación dentro del flujo de cierre: usa el período global
// y permite el drill-down al auxiliar de cada cuenta.

import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { BotonImprimir, PrintHeader } from "@/components/contabilidad/PrintHeader";
import { BalanzaPanel } from "@/components/contabilidad/BalanzaPanel";

export default function BalanzaPage() {
  const { activeCompany } = useCompany();
  const { year, month } = usePeriod();
  if (!activeCompany) return null;
  return (
    <div>
      <PrintHeader title="Balanza de comprobación" />
      {/* El encabezado de pantalla no va al papel: PrintHeader lo sustituye. */}
      <div className="print:hidden">
        <FlowPageHeader title="Balanza" actions={<BotonImprimir />} />
      </div>
      <BalanzaPanel companyId={activeCompany.id} year={year} month={month} />
    </div>
  );
}
