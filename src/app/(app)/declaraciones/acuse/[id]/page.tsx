"use client";

import { use } from "react";
import { VisorPdf } from "@/components/ui";
import { rutaInternaSegura } from "@/lib/navegacion";

// Visor in-app del acuse de una declaración. Evita abrir el PDF crudo (que en
// la PWA deja al usuario sin botón de regreso ni descarga). Siempre muestra
// "Volver" — a donde diga ?volver=, validado como ruta interna.
export default function DeclaracionAcuseViewer({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = use(params);
  const sp = use(searchParams);

  return (
    <VisorPdf
      src={`/api/declaraciones/acuse/${id}`}
      titulo="Acuse de la declaración"
      nombreArchivo={`acuse-declaracion-${id}.pdf`}
      volverHref={rutaInternaSegura(sp.volver, "/impuestos?tab=historial")}
    />
  );
}
