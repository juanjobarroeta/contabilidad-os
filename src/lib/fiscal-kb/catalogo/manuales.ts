// ─────────────────────────────────────────────────────────────────────────────
// Fuentes que NO salen del índice de Diputados o que lo corrigen: reglamentos
// (viven en /regley con nombre de archivo fechado), leyes estatales (cada
// congreso publica distinto) y la LINFONAVIT, que se ingiere desde el PDF
// «móvil» de Diputados desde la Fase 1 (cambiar de PDF cambiaría el hash y
// abriría una versión espuria). Se mezclan ENCIMA del catálogo generado
// (catalogo/federal.json): misma clave → gana esta entrada.
//
// Los nombres de archivo de los reglamentos llevan fecha (Reg_LISR_060516) —
// si Diputados los renombra, el refresco falla en voz alta y se corrige aquí.
// ─────────────────────────────────────────────────────────────────────────────

import type { LeyDescriptor } from "../ingest-leyes";

export const LEYES_MANUALES: Record<string, LeyDescriptor> = {
  // ── Construcción · Ciudad de México (docs/MOTOR-JURIDICO.md F3) ──────────
  // El Reglamento de Construcciones es artículo por artículo (chunker de ley);
  // las diez Normas Técnicas Complementarias de 2023 vienen en un solo PDF de
  // la Gaceta, numeradas por secciones: chunker genérico (kind "guia").
  RCCDMX: {
    clave: "RCCDMX",
    titulo: "Reglamento de Construcciones para el Distrito Federal (Ciudad de México)",
    url: "https://data.consejeria.cdmx.gob.mx/images/leyes/reglamentos/RGTO_DE_CONSTRUCCIONES_DEL_DISTRITO_FEDERAL_7.7.pdf",
    source: "REGLAMENTO",
    materias: ["construccion", "urbano"],
    ambito: "ESTATAL",
    entidad: "CMX",
  },
  "NTC-RCDF-2023": {
    clave: "NTC-RCDF-2023",
    titulo: "Normas Técnicas Complementarias del Reglamento de Construcciones para el Distrito Federal (Gaceta Oficial CDMX, 6 de noviembre de 2023)",
    url: "https://data.consejeria.cdmx.gob.mx/portal_old/uploads/gacetas/b3c4f4ff37241d0a93cc6742a8b0bf2f.pdf",
    source: "NOM",
    kind: "guia",
    vigenciaFallback: "2023-11-06",
    materias: ["construccion"],
    ambito: "ESTATAL",
    entidad: "CMX",
  },
  // ── Reglamentos fiscales ─────────────────────────────────────────────────────
  RLISR: {
    clave: "RLISR",
    titulo: "Reglamento de la Ley del Impuesto sobre la Renta",
    url: "https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LISR_060516.pdf",
    source: "REGLAMENTO",
    materias: ["fiscal"],
    ambito: "FEDERAL",
  },
  RLIVA: {
    clave: "RLIVA",
    titulo: "Reglamento de la Ley del Impuesto al Valor Agregado",
    url: "https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LIVA_250914.pdf",
    source: "REGLAMENTO",
    materias: ["fiscal"],
    ambito: "FEDERAL",
  },
  RCFF: {
    clave: "RCFF",
    titulo: "Reglamento del Código Fiscal de la Federación",
    url: "https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_CFF.pdf",
    source: "REGLAMENTO",
    // Nuevo Reglamento publicado en el DOF el 2 de abril de 2014; sin reformas
    // desde entonces, así que el encabezado no trae «Última reforma DOF».
    vigenciaFallback: "2014-04-02",
    materias: ["fiscal", "procesal"],
    ambito: "FEDERAL",
  },
  // ── Nómina: la LINFONAVIT desde el PDF móvil (ver nota de cabecera) ─────────
  LINFONAVIT: {
    clave: "LINFONAVIT",
    titulo: "Ley del Instituto del Fondo Nacional de la Vivienda para los Trabajadores",
    url: "https://www.diputados.gob.mx/LeyesBiblio/pdf_mov/Ley_del_Instituto_del_Fondo_Nacional_de_la_Vivienda.pdf",
    urlRef: "https://www.diputados.gob.mx/LeyesBiblio/ref/lifnvt.htm",
    materias: ["seguridad_social", "laboral", "vivienda"],
    ambito: "FEDERAL",
  },
  // ── Periferia de nómina (reglamentos IMSS / INFONAVIT) ──────────────────────
  RACERF: {
    clave: "RACERF",
    titulo: "Reglamento de la Ley del Seguro Social en Materia de Afiliación, Clasificación de Empresas, Recaudación y Fiscalización",
    url: "https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LSS_MACERF.pdf",
    source: "REGLAMENTO",
    materias: ["seguridad_social", "laboral"],
    ambito: "FEDERAL",
  },
  RIPAEDI: {
    clave: "RIPAEDI",
    titulo: "Reglamento de Inscripción, Pago de Aportaciones y Entero de Descuentos al INFONAVIT",
    // Diputados sirve el facsímil del DOF (encabezados «ARTÍCULO 1.» en mayúsculas).
    url: "https://www.diputados.gob.mx/LeyesBiblio/regla/n327.pdf",
    source: "REGLAMENTO",
    vigenciaFallback: "2012-02-10",
    materias: ["seguridad_social", "laboral", "vivienda"],
    ambito: "FEDERAL",
  },
  // ── Cumplimiento ─────────────────────────────────────────────────────────────
  RLFPIORPI: {
    clave: "RLFPIORPI",
    titulo: "Reglamento de la Ley Federal para la Prevención e Identificación de Operaciones con Recursos de Procedencia Ilícita",
    url: "https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LFPIORPI.pdf",
    source: "REGLAMENTO",
    vigenciaFallback: "2013-08-16",
    materias: ["pld", "mercantil"],
    ambito: "FEDERAL",
  },
  // ── Estatal (impuesto sobre nómina y demás contribuciones locales) ───────────
  // Puebla: Orden Jurídico Poblano (texto vigente con tabla de reformas).
  LHPUE: {
    clave: "LHPUE",
    titulo: "Ley de Hacienda para el Estado Libre y Soberano de Puebla",
    url: "https://ojp.puebla.gob.mx/legislacion-del-estado/item/download/7789_d874b176dd9ccf4b0a3233bb2f183cd4",
    vigenciaFallback: "2024-08-05",
    materias: ["fiscal"],
    ambito: "ESTATAL",
    entidad: "PUE",
  },
  CFPUE: {
    clave: "CFPUE",
    titulo: "Código Fiscal del Estado de Puebla",
    url: "https://ojp.puebla.gob.mx/media/k2/attachments/Codigo_Fiscal_del_Estado_de_Puebla_T6_31072025.pdf",
    vigenciaFallback: "2025-07-31",
    materias: ["fiscal", "procesal"],
    ambito: "ESTATAL",
    entidad: "PUE",
  },
  // CDMX: la Consejería Jurídica publica el texto vigente (reformado cada
  // diciembre; el ISN subió a 4 % — el PDF del Congreso es de 2021 y dice 3 %,
  // por eso NO se usa). El sitio de la Consejería a veces no responde; la
  // ingesta falla en voz alta y el refresco semanal reintenta.
  CFCDMX: {
    clave: "CFCDMX",
    titulo: "Código Fiscal de la Ciudad de México",
    url: "https://data.consejeria.cdmx.gob.mx/images/leyes/codigos/CODIGO_FISCAL_DE_LA_CDMX_6.2.pdf",
    materias: ["fiscal", "procesal"],
    ambito: "ESTATAL",
    entidad: "CMX",
  },
};
