"use client";

// Stub temporal — este segmento se construye en la migración del flujo de
// cierre (rama redesign/cierre-flow). Ver docs/BRIEF-UX-contabilidad.md.

import { FlowPageHeader } from "@/components/contabilidad/FlowPageHeader";

export default function Page() {
  return (
    <div>
      <FlowPageHeader title="Divergencia" />
      <div className="rounded-card border border-cos-line bg-cos-card p-8 text-sm text-cos-ink-soft">
        En construcción — mientras tanto, esta vista sigue disponible en la
        página anterior de Contabilidad.
      </div>
    </div>
  );
}
