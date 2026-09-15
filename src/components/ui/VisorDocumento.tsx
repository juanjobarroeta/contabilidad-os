"use client";

// ─────────────────────────────────────────────────────────────────────────────
// VER UN PDF SIN SALIRSE DE LA APLICACIÓN.
//
// Un `<a target="_blank">` a un PDF funciona en un navegador de escritorio, que
// tiene pestañas y flecha de regreso. Instalada en el teléfono, la app corre en
// modo standalone: NO HAY BARRA NI FLECHA. El PDF se abre encima y el usuario
// se queda ahí —la única salida es cerrar la app y volver a entrar, perdiendo
// dónde estaba—. Pasó con el estado de cuenta en Bancos.
//
// Esto lo enseña dentro, con una X. Y deja las dos salidas de siempre para
// quien esté en escritorio: abrirlo en pestaña y descargarlo.
//
// El PDF se pinta en un <iframe>: en escritorio se ve completo, y en algunos
// iOS el visor embebido enseña sólo la primera página — por eso el botón de
// descarga NO es decorativo, es el plan B, y el usuario sigue dentro de la app.
// ─────────────────────────────────────────────────────────────────────────────

import { Download, ExternalLink, X } from "lucide-react";

export function VisorDocumento({
  url,
  titulo,
  onClose,
}: {
  url: string;
  titulo: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/70 p-0 sm:p-6" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="mx-auto flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-none bg-cos-card sm:rounded-card"
      >
        <div className="flex items-center gap-3 border-b border-cos-line px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold text-cos-ink">{titulo}</h2>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            title="Abrir en una pestaña"
            className="rounded-control border border-cos-line p-1.5 text-cos-ink-soft hover:bg-cos-paper"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
          <a
            href={url}
            download
            title="Descargar"
            className="rounded-control border border-cos-line p-1.5 text-cos-ink-soft hover:bg-cos-paper"
          >
            <Download className="h-4 w-4" />
          </a>
          <button onClick={onClose} aria-label="Cerrar" className="rounded-control p-1.5 text-cos-ink-soft hover:bg-cos-paper">
            <X className="h-5 w-5" />
          </button>
        </div>
        <iframe src={url} title={titulo} className="min-h-0 flex-1 w-full bg-cos-paper" />
      </div>
    </div>
  );
}
