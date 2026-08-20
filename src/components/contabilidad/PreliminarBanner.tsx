"use client";

// Aviso compartido por Balanza y Estado de resultados: el periodo aún no se
// cerró, así que las cifras son un cálculo directo de los CFDIs.

import { AlertCircle } from "lucide-react";

export function PreliminarBanner() {
  return (
    <div className="mb-4 flex items-start gap-2 rounded-card border border-cos-line bg-cos-slate-tint px-4 py-3 text-sm text-cos-ink">
      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-cos-ink-soft" />
      <span>
        <span className="font-medium">Preliminar</span> — el mes aún no se ha cerrado.
        Cálculo directo de tus CFDIs; cierra el mes para generar las pólizas.
      </span>
    </div>
  );
}
