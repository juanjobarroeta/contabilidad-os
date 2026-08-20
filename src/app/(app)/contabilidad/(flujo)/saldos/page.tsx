"use client";

// Saldos interempresa dentro del flujo de cierre. La posición neta es
// acumulada, así que no depende del período global.

import { useCompany } from "@/components/layout/CompanyProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { SaldosInterempresaPanel } from "@/components/contabilidad/SaldosInterempresaPanel";

export default function SaldosPage() {
  const { activeCompany } = useCompany();
  if (!activeCompany) return null;
  return (
    <div>
      <FlowPageHeader title="Saldos interempresa" />
      <SaldosInterempresaPanel companyId={activeCompany.id} />
    </div>
  );
}
