"use client";

import { usePathname } from "next/navigation";
import { TopTabsBar } from "@/components/layout/TopTabsBar";

// La tira del hub de Directorio. Nació como píldoras copiadas en Clientes y
// Proveedores (el Verificador ni las tenía y era un callejón sin salida);
// ahora es la tira superior estándar (TopTabsBar), la misma de Nómina y
// Bancos. Va ARRIBA del contenedor con padding de cada página.
const SECCIONES = [
  { href: "/clientes", label: "Clientes" },
  { href: "/proveedores", label: "Proveedores" },
  { href: "/verificador", label: "Verificar RFC", title: "Verificar RFC/CURP/NSS y lista 69-B" },
];

export function DirectorioNav() {
  const pathname = usePathname();
  return (
    <TopTabsBar
      ariaLabel="Secciones del Directorio"
      tabs={SECCIONES.map((s) => ({
        key: s.href,
        label: s.label,
        href: s.href,
        title: s.title,
        active: pathname.startsWith(s.href),
      }))}
    />
  );
}
