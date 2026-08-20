"use client";

import { useCompany } from "@/components/layout/CompanyProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { ActivoFijoView } from "@/components/contabilidad/ActivoFijoView";

export default function ActivoFijoPage() {
  const { activeCompany } = useCompany();
  if (!activeCompany) return null;
  return (
    <div>
      <FlowPageHeader title="Activo fijo" />
      <ActivoFijoView />
    </div>
  );
}
