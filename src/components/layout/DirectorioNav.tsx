"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Píldoras del hub de Directorio. Vivían copiadas en Clientes y Proveedores, y
// el Verificador no las tenía: entrar desde «Verificar RFC» era un callejón
// sin salida (reporte del owner con captura). Un solo componente, tres
// pantallas, siempre se puede volver.
const PILDORAS = [
  { href: "/clientes", label: "Clientes" },
  { href: "/proveedores", label: "Proveedores" },
  { href: "/verificador", label: "Verificar RFC", title: "Verificar RFC/CURP/NSS y lista 69-B" },
];

export function DirectorioNav() {
  const pathname = usePathname();
  return (
    <nav className="mb-2 inline-flex rounded-control border border-cos-line p-0.5 text-[12.5px] font-medium">
      {PILDORAS.map((p) => (
        <Link
          key={p.href}
          href={p.href}
          title={p.title}
          className={
            pathname.startsWith(p.href)
              ? "rounded-[8px] bg-cos-slate-tint px-2.5 py-1 text-cos-ink"
              : "rounded-[8px] px-2.5 py-1 text-cos-ink-soft hover:text-cos-ink"
          }
        >
          {p.label}
        </Link>
      ))}
    </nav>
  );
}
