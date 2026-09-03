// Registro de documentos legales y sus versiones vigentes (lógica pura, sin DB).
//
// La "versión" de un documento es la fecha de su última modificación sustancial
// (ISO, YYYY-MM-DD), la misma que se muestra en la página /legal/* como
// «Última actualización». Al cambiar el texto de un documento:
//   1. Se edita la página en src/app/legal/<doc>/page.tsx y su fecha.
//   2. Se sube aquí la versión a esa misma fecha.
// Con eso, todo usuario cuya última aceptación sea anterior vuelve a ver la
// pantalla de aceptación (AceptacionLegalGate) al entrar a la app.
//
// La evidencia de cada aceptación se guarda en LegalAcceptance (append-only);
// ver src/lib/legal/aceptaciones.ts.
import type { LegalDocumento } from "@prisma/client";

export type DocumentoLegal = {
  documento: LegalDocumento;
  version: string;
  titulo: string;
  url: string;
};

/** Documentos que TODO usuario debe aceptar para usar la Plataforma. */
export const DOCUMENTOS_CUENTA: readonly DocumentoLegal[] = [
  {
    documento: "TERMINOS",
    version: "2026-09-03",
    titulo: "Términos y Condiciones",
    url: "/legal/terminos",
  },
  {
    documento: "AVISO_PRIVACIDAD",
    version: "2026-09-03",
    titulo: "Aviso de Privacidad",
    url: "/legal/aviso-de-privacidad",
  },
] as const;

/**
 * Autorización de uso de la e.firma: se acepta POR EMPRESA, cada vez que se
 * carga o reemplaza la e.firma de esa empresa. No forma parte del gate general.
 */
export const MANDATO_EFIRMA: DocumentoLegal = {
  documento: "MANDATO_EFIRMA",
  version: "2026-09-03",
  titulo: "Autorización de uso de la e.firma",
  url: "/legal/mandato-efirma",
};

export function versionVigente(documento: LegalDocumento): string {
  if (documento === "MANDATO_EFIRMA") return MANDATO_EFIRMA.version;
  const doc = DOCUMENTOS_CUENTA.find((d) => d.documento === documento);
  if (!doc) throw new Error(`Documento legal sin versión registrada: ${documento}`);
  return doc.version;
}

export type AceptacionPrevia = { documento: LegalDocumento; version: string };

/**
 * Dado lo que el usuario ya aceptó, devuelve los documentos de cuenta que aún
 * debe aceptar: los que nunca aceptó y los cuya versión vigente es más nueva
 * que la última aceptada. Las versiones son fechas ISO, así que la comparación
 * lexicográfica equivale a la cronológica.
 */
export function documentosPendientes(
  aceptadas: readonly AceptacionPrevia[]
): DocumentoLegal[] {
  const ultimaPorDoc = new Map<LegalDocumento, string>();
  for (const a of aceptadas) {
    const prev = ultimaPorDoc.get(a.documento);
    if (!prev || a.version > prev) ultimaPorDoc.set(a.documento, a.version);
  }
  return DOCUMENTOS_CUENTA.filter((doc) => {
    const ultima = ultimaPorDoc.get(doc.documento);
    return !ultima || ultima < doc.version;
  });
}
