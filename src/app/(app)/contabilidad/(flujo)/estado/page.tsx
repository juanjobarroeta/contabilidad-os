"use client";

// Estado de resultados dentro del flujo de cierre: usa el período global.

import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { BotonImprimir, PrintHeader } from "@/components/contabilidad/PrintHeader";
import { EstadoResultadosPanel } from "@/components/contabilidad/EstadoResultadosPanel";

export default function EstadoPage() {
  const { activeCompany } = useCompany();
  const { year, month, setPeriod } = usePeriod();
  if (!activeCompany) return null;
  return (
    <div>
      <PrintHeader title="Estado de resultados" />
      {/* El encabezado de pantalla no va al papel: PrintHeader lo sustituye. */}
      <div className="print:hidden">
        <FlowPageHeader title="Estado de resultados" actions={<BotonImprimir />} />
      </div>
      <EstadoResultadosPanel companyId={activeCompany.id} year={year} month={month} onChangePeriod={setPeriod} />
    </div>
  );
}
