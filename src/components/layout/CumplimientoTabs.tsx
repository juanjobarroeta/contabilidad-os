"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Hub de Cumplimiento: tres pantallas que ahora viven como pestañas de un mismo
// destino. Las rutas no cambian (cada pestaña enlaza a su página actual), así que
// los enlaces existentes siguen funcionando; sólo se presentan agrupadas.
const TABS = [
  { href: "/cumplimiento", label: "Estatus" },
  { href: "/opiniones", label: "Opiniones SAT" },
  { href: "/hallazgos", label: "Hallazgos" },
  // El Verificador llegaba desde aquí pero perdía las pestañas: callejón sin
  // salida (reporte del owner). Es parte del hub — consulta cualquier RFC.
  { href: "/verificador", label: "Verificador" },
];

export function CumplimientoTabs() {
  const pathname = usePathname();
  return (
    <div className="mb-6 flex gap-1 overflow-x-auto border-b border-cos-line">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(t.href + "/");
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`-mb-px whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
              active
                ? "border-cos-brand text-cos-brand-ink"
                : "border-transparent text-cos-ink-soft hover:text-cos-ink"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
