"use client";

// Paso 5 del flujo: los entregables del mes para el buzón — los cinco XML del
// Anexo 24 generados desde la contabilidad viva (catálogo, balanza, pólizas,
// aux. de cuentas y aux. de folios), con su readiness. El panel consolida lo
// que era el tab "Contabilidad Electrónica".

import { useEffect, useState } from "react";
import { useCompany } from "@/components/layout/CompanyProvider";
import { usePeriod } from "@/components/contabilidad/PeriodProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import {
  ContabilidadElectronicaPanel,
  type Period,
} from "@/components/contabilidad/ContabilidadElectronicaPanel";

export default function EntregablesPage() {
  const { activeCompany } = useCompany();
  const { year, month, setPeriod } = usePeriod();
  const [periods, setPeriods] = useState<Period[]>([]);

  useEffect(() => {
    if (!activeCompany) return;
    (async () => {
      const res = await fetch(`/api/contabilidad/periods?companyId=${activeCompany.id}`);
      const d = await res.json().catch(() => null);
      setPeriods(Array.isArray(d) ? d : []);
    })();
  }, [activeCompany]);

  if (!activeCompany) return null;
  return (
    <div>
      <FlowPageHeader title="Entregables" />
      <ContabilidadElectronicaPanel
        companyId={activeCompany.id}
        periods={periods}
        year={year}
        month={month}
        onChangePeriod={setPeriod}
      />
    </div>
  );
}
