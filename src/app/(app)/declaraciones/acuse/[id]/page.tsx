"use client";

import { use } from "react";
import Link from "next/link";
import { ChevronLeft, FileDown } from "lucide-react";

// Visor in-app del acuse de una declaración. Evita abrir el PDF crudo en _blank
// (que en la PWA deja al usuario sin botón de regreso). Siempre muestra "Volver".
export default function DeclaracionAcuseViewer({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const src = `/api/declaraciones/acuse/${id}`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-cos-line bg-cos-card px-3 py-2.5 sm:px-4">
        <Link
          href="/declaraciones"
          className="inline-flex items-center gap-1 rounded-control px-2 py-1.5 text-sm font-medium text-cos-ink hover:bg-cos-paper"
        >
          <ChevronLeft className="h-4 w-4" /> Volver
        </Link>
        <span className="truncate text-sm font-medium text-cos-ink-soft">Acuse</span>
        <a
          href={src}
          download
          className="inline-flex items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-sm font-medium text-cos-ink hover:bg-cos-paper"
        >
          <FileDown className="h-4 w-4" /> Descargar
        </a>
      </div>
      <iframe src={src} title="Acuse de la declaración" className="w-full flex-1 border-0 bg-cos-slate-tint" />
    </div>
  );
}
