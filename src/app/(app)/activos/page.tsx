"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Ruta /activos — respaldo del registro de Activo fijo.
//
// El cuerpo vive en <ActivoFijoView /> (src/components/contabilidad), que también
// se renderiza como pestaña dentro del hub de Contabilidad
// (/contabilidad?tab=activo-fijo). next.config.ts redirige /activos a esa
// pestaña; esta página se conserva como respaldo por si la redirección estuviera
// deshabilitada.
// ─────────────────────────────────────────────────────────────────────────────

import { ActivoFijoView } from "@/components/contabilidad/ActivoFijoView";

export default function ActivosPage() {
  return (
    <div className="mx-auto max-w-[1080px] px-6 py-7">
      <h1 className="mb-4 text-[24px] font-bold tracking-[-0.02em] text-cos-ink">Activo fijo</h1>
      <ActivoFijoView />
    </div>
  );
}
