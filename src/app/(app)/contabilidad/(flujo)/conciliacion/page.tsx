"use client";

// Paso 2 del flujo: la conciliación bancaria es COMPUERTA del cierre — el
// motor no postea un mes con movimientos sin conciliar (regla existente).
// Arriba, la mesa split-view para RESOLVER los pendientes (deck People, p10);
// abajo, el papel de conciliación de siempre. Al aplicar un match, el papel
// se remonta (key) para releer el mes.

import { useState } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { ConciliacionWorkbench } from "@/components/contabilidad/ConciliacionWorkbench";
import { ConciliacionBancariaPanel } from "@/components/contabilidad/ConciliacionBancariaPanel";

export default function ConciliacionPage() {
  const { activeCompany } = useCompany();
  const { year, month } = usePeriod();
  const [version, setVersion] = useState(0);
  if (!activeCompany) return null;
  return (
    <div>
      <FlowPageHeader title="Conciliación bancaria" />
      <ConciliacionWorkbench
        companyId={activeCompany.id}
        year={year}
        month={month}
        onApplied={() => setVersion((v) => v + 1)}
      />
      <ConciliacionBancariaPanel
        key={version}
        companyId={activeCompany.id}
        year={year}
        month={month}
      />
    </div>
  );
}
