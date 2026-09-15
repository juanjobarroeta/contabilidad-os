"use client";

// ─────────────────────────────────────────────────────────────────────────────
// Visor in-app de un PDF del mismo origen (acuses, constancia de situación
// fiscal, opiniones). Dos reglas, las dos salidas de reportes reales en la PWA
// instalada (iOS standalone, sin chrome del navegador):
//
//   1. NUNCA navegar al PDF crudo. Ahí la pantalla queda sin "atrás" ni
//      "descargar" y el usuario se queda atrapado en el visor nativo del
//      sistema: la única salida es matar la app. El PDF se pinta en un iframe
//      DEBAJO de una barra que siempre lleva Volver y Descargar.
//
//   2. "Descargar" no puede ser <a download>. En standalone iOS el atributo se
//      ignora y el ancla NAVEGA al PDF — el mismo callejón sin salida, ahora
//      desde adentro del visor. Aquí el archivo se baja con fetch y se entrega
//      con descargarBlob (hoja de compartir en la PWA, ancla en el navegador),
//      y si el servidor responde error se PINTA, no se descarga basura.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from "react";
import Link from "next/link";
import { ChevronLeft, FileDown, Loader2 } from "lucide-react";
import { descargarBlob } from "@/lib/descargar";
import { Alert } from "./feedback";

export interface VisorPdfProps {
  /** URL del mismo origen que sirve el PDF. */
  src: string;
  /** Qué documento es — se muestra en la barra. */
  titulo: string;
  /** Nombre de respaldo si el servidor no manda Content-Disposition. */
  nombreArchivo: string;
  /** Ruta interna a la que regresa el botón Volver. */
  volverHref: string;
  volverLabel?: string;
}

export function VisorPdf({ src, titulo, nombreArchivo, volverHref, volverLabel = "Volver" }: VisorPdfProps) {
  const [descargando, setDescargando] = useState(false);
  const [error, setError] = useState("");

  async function descargar() {
    setDescargando(true);
    setError("");
    try {
      const res = await fetch(src);
      if (!res.ok) {
        let cuerpo: { error?: string } | null = null;
        try {
          cuerpo = await res.json();
        } catch {
          /* respuesta no-JSON: mensaje genérico */
        }
        setError(cuerpo?.error ?? `No se pudo descargar el documento (HTTP ${res.status}).`);
        return;
      }
      const cd = res.headers.get("Content-Disposition") ?? "";
      const delServidor = /filename="([^"]+)"/.exec(cd)?.[1];
      await descargarBlob(await res.blob(), delServidor ?? nombreArchivo);
    } catch {
      setError("No se pudo descargar. Revisa tu conexión e intenta de nuevo.");
    } finally {
      setDescargando(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-cos-line bg-cos-card px-3 py-2.5 sm:px-4">
        <Link
          href={volverHref}
          className="inline-flex shrink-0 items-center gap-1 rounded-control px-2 py-1.5 text-sm font-medium text-cos-ink hover:bg-cos-paper"
        >
          <ChevronLeft className="h-4 w-4" /> {volverLabel}
        </Link>
        <span className="truncate text-sm font-medium text-cos-ink-soft">{titulo}</span>
        <button
          type="button"
          onClick={descargar}
          disabled={descargando}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-control border border-cos-line bg-cos-card px-3 py-1.5 text-sm font-medium text-cos-ink hover:bg-cos-paper disabled:opacity-50"
        >
          {descargando ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
          {descargando ? "Preparando…" : "Descargar"}
        </button>
      </div>

      {error && (
        <Alert tone="danger" className="m-3 sm:mx-4">
          {error}
        </Alert>
      )}

      <iframe src={src} title={titulo} className="w-full flex-1 border-0 bg-cos-slate-tint" />

      <p className="border-t border-cos-line bg-cos-card px-3 py-2 text-center text-[12px] text-cos-ink-faint sm:px-4">
        ¿No se ve el documento? Usa <strong className="font-semibold">Descargar</strong> para guardarlo o
        compartirlo desde tu dispositivo.
      </p>
    </div>
  );
}
