"use client";

// ─────────────────────────────────────────────────────────────────────────────
// /contabilidad ya no es la página de 10 tabs: es la puerta al flujo de cierre
// (rutas por segmento bajo (flujo)). Este redirect honra los deep-links viejos
// ?tab= — incluida la redirección de /activos, que llega con ?tab=activo-fijo —
// y preserva el período si viene ?y=&m=.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const DESTINO: Record<string, string> = {
  periods: "/contabilidad/cierre",
  coe: "/contabilidad/entregables",
  "ce-presentado": "/contabilidad/presentado",
  libro: "/contabilidad/libro",
  balanza: "/contabilidad/balanza",
  conciliacion: "/contabilidad/conciliacion",
  estado: "/contabilidad/estado",
  balance: "/contabilidad/balance",
  saldos: "/contabilidad/saldos",
  "activo-fijo": "/contabilidad/activo-fijo",
};

export default function ContabilidadRedirect() {
  const router = useRouter();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    const base = (tab && DESTINO[tab]) || "/contabilidad/cierre";
    params.delete("tab");
    const qs = params.toString();
    router.replace(qs ? `${base}?${qs}` : base);
  }, [router]);

  return (
    <div className="p-8 text-sm text-cos-ink-soft">Abriendo el flujo de cierre…</div>
  );
}
