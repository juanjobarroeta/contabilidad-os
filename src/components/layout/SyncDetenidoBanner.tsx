"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useCompany } from "./CompanyProvider";

// Franja roja bajo la barra superior cuando la descarga del SAT de la empresa
// activa está detenida (e.firma vencida, revocada por el SAT, o sin avanzar
// en 7 días). El aviso en Pendientes y el push se quedaban sin leer meses
// (BAHJ, jul–oct 2026); esto no se puede no ver.
export function SyncDetenidoBanner() {
  const { activeCompany } = useCompany();
  const companyId = activeCompany?.id;
  const [salud, setSalud] = useState<{ detenida: boolean; motivo: string | null; detalle: string } | null>(null);

  useEffect(() => {
    if (!companyId) return;
    let vivo = true;
    fetch(`/api/sat/salud?companyId=${encodeURIComponent(companyId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (vivo) setSalud(j); })
      .catch(() => { if (vivo) setSalud(null); });
    return () => { vivo = false; };
  }, [companyId]);

  if (!salud?.detenida) return null;
  return (
    <div className="px-4 py-2 text-sm flex items-center justify-between gap-3 border-b bg-red-50 border-red-200 text-red-900">
      <span>{salud.detalle}</span>
      <Link href="/empresa" className="shrink-0 font-medium underline hover:no-underline">
        {salud.motivo === "sin_sync" ? "Revisar" : "Subir e.firma"}
      </Link>
    </div>
  );
}
