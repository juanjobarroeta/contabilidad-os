"use client";

import { Download } from "lucide-react";

/**
 * Descarga de un estado financiero como hoja de Excel.
 *
 * El CSV entregaba TEXTO: el contador seleccionaba la columna de importes y
 * Excel no le sumaba nada. En el xlsx los números van como números y las
 * fechas como fechas, que es lo que vuelve útil el archivo.
 */
export function BotonExcel({ href, label = "Excel" }: { href: string; label?: string }) {
  return (
    <a
      href={href}
      title="Descargar como hoja de Excel (importes sumables)"
      className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-paper px-2.5 py-1.5 text-xs font-medium text-cos-ink hover:bg-cos-slate-tint"
    >
      <Download className="h-3.5 w-3.5" /> {label}
    </a>
  );
}
