"use client";

import { use } from "react";
import { VisorPdf } from "@/components/ui";
import { rutaInternaSegura } from "@/lib/navegacion";

// Visor in-app del acuse de cumplimiento: opinión SAT (32-D), Constancia de
// Situación Fiscal u opinión IMSS. El PDF lo sirve
// /api/cumplimiento/acuse/[snapshotId]; se embebe aquí en vez de navegar al PDF
// crudo para que SIEMPRE haya Volver y Descargar — en la PWA instalada (sin
// chrome del navegador) abrir el PDF directo deja al usuario sin salida.
//
// ?doc= etiqueta la barra (es el mismo endpoint para los tres documentos) y
// ?volver= dice a dónde regresa, validado como ruta interna.

const TITULOS: Record<string, string> = {
  csf: "Constancia de Situación Fiscal",
  sat: "Opinión de cumplimiento (32-D)",
  imss: "Opinión de cumplimiento IMSS",
};

const NOMBRES: Record<string, string> = {
  csf: "constancia-situacion-fiscal",
  sat: "opinion-cumplimiento-sat",
  imss: "opinion-cumplimiento-imss",
};

export default function AcuseViewerPage({
  params,
  searchParams,
}: {
  params: Promise<{ snapshotId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { snapshotId } = use(params);
  const sp = use(searchParams);

  const docParam = Array.isArray(sp.doc) ? sp.doc[0] : sp.doc;
  const doc = docParam && docParam in TITULOS ? docParam : null;

  return (
    <VisorPdf
      src={`/api/cumplimiento/acuse/${snapshotId}`}
      titulo={doc ? TITULOS[doc] : "Acuse"}
      nombreArchivo={`${doc ? NOMBRES[doc] : "acuse"}-${snapshotId}.pdf`}
      volverHref={rutaInternaSegura(sp.volver, "/opiniones")}
    />
  );
}
