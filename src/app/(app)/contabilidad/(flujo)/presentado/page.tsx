"use client";

// Lo LEÍDO de las balanzas CE presentadas al SAT (CeBalanzaMes): lo que el
// contador declaró, no lo que el motor derivó. El lado "declarado" de la
// divergencia, como reporte navegable.

import { useCompany } from "@/components/layout/CompanyProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { CePresentadoPanel } from "@/components/contabilidad/CePresentadoPanel";

export default function PresentadoPage() {
  const { activeCompany } = useCompany();
  if (!activeCompany) return null;
  return (
    <div>
      <FlowPageHeader title="Presentado (CE)" subtitle="Balanzas presentadas al SAT, por período" />
      <CePresentadoPanel companyId={activeCompany.id} />
    </div>
  );
}
