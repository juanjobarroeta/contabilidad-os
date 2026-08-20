"use client";

// Lo LEÍDO de las balanzas CE presentadas al SAT (CeBalanzaMes): lo que el
// contador declaró, no lo que el motor derivó. El lado "declarado" de la
// divergencia, como reporte navegable.

import { useCompany } from "@/components/layout/CompanyProvider";
import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";
import { BotonImprimir, PrintHeader } from "@/components/contabilidad/PrintHeader";
import { CePresentadoPanel } from "@/components/contabilidad/CePresentadoPanel";

export default function PresentadoPage() {
  const { activeCompany } = useCompany();
  if (!activeCompany) return null;
  return (
    <div>
      {/* El período impreso exacto lo pone el panel (maneja su propia selección
          CE, distinta del período global del flujo); aquí sólo el contexto. */}
      <PrintHeader title="Balanza presentada (CE)" periodo="Balanza presentada al SAT" />
      {/* El encabezado de pantalla no va al papel: PrintHeader lo sustituye. */}
      <div className="print:hidden">
        <FlowPageHeader
          title="Presentado (CE)"
          subtitle="Balanzas presentadas al SAT, por período"
          actions={<BotonImprimir />}
        />
      </div>
      <CePresentadoPanel companyId={activeCompany.id} />
    </div>
  );
}
