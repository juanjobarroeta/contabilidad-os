"use client";

import { use } from "react";
import Link from "next/link";
import { ChevronLeft, FileDown } from "lucide-react";

// In-app acuse viewer. The PDF itself is streamed by /api/cumplimiento/acuse/[id].
// We embed it here instead of navigating straight to the raw PDF so there's
// always a "Volver" control — in the standalone PWA (no browser chrome) opening
// the PDF directly leaves the user with no way back. A "Descargar" fallback
// covers browsers that won't render a PDF inside an iframe (some iOS builds).
export default function AcuseViewerPage({ params }: { params: Promise<{ snapshotId: string }> }) {
  const { snapshotId } = use(params);
  const src = `/api/cumplimiento/acuse/${snapshotId}`;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-cos-line bg-cos-card px-3 py-2.5 sm:px-4">
        <Link
          href="/opiniones"
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
      <iframe src={src} title="Acuse de cumplimiento" className="w-full flex-1 border-0 bg-cos-slate-tint" />
    </div>
  );
}
