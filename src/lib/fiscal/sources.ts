// ─────────────────────────────────────────────────────────────────────────────
// Registry of the fiscal sources the brain depends on, with how often each one
// changes and how it gets refreshed. This is the backbone for "perpetually
// update the library": a monitoring cron iterates `fuentesAuto()` to re-ingest
// the self-updating sources, and surfaces the `manual`/`semiauto` ones (and any
// that look stale for their cadencia) as reminders.
//
// Two halves of the brain:
//   • capa "narrativa" → KB en Postgres (FiscalDocument/FiscalChunk), refrescada
//     por ingesta (src/lib/fiscal-kb).
//   • capa "reglas"    → catálogo versionado en git (src/lib/fiscal/rules),
//     refrescado por PR revisado.
// ─────────────────────────────────────────────────────────────────────────────

export type CapaBrain = "narrativa" | "reglas";

/** Con qué frecuencia cambia / hay que revisar la fuente. */
export type Cadencia = "diaria" | "mensual" | "anual" | "por-publicacion";

/** ¿Puede el cerebro auto-actualizarla? */
export type MetodoRefresco =
  | "auto" // cron re-ingesta sin intervención (fuente pública, idempotente)
  | "semiauto" // cron puede dispararla pero requiere insumo (p.ej. PDF) o revisión
  | "manual"; // requiere captura/PR humano

/** ¿Ya está en el cerebro o es un pendiente identificado? */
export type EstadoFuente = "activo" | "pendiente";

export interface FuenteFiscal {
  clave: string;
  nombre: string;
  capa: CapaBrain;
  cadencia: Cadencia;
  metodo: MetodoRefresco;
  estado: EstadoFuente;
  /** Cómo se refresca (endpoint/script/acción manual). */
  refresco: string;
  /** Quién la publica. */
  autoridad: string;
  notas?: string;
}

export const FUENTES: FuenteFiscal[] = [
  // ── Capa narrativa (KB) — leyes federales, auto desde diputados.gob.mx ───────
  {
    clave: "LISR",
    nombre: "Ley del Impuesto Sobre la Renta",
    capa: "narrativa",
    cadencia: "por-publicacion",
    metodo: "auto",
    estado: "activo",
    refresco: 'POST /api/admin/fiscal-ingest {"type":"ley","clave":"LISR"}',
    autoridad: "Cámara de Diputados (texto vigente)",
    notas: "Reformas típicas en el Paquete Económico anual (dic, vigor 1-ene). Ingesta idempotente (hash).",
  },
  {
    clave: "LIVA",
    nombre: "Ley del Impuesto al Valor Agregado",
    capa: "narrativa",
    cadencia: "por-publicacion",
    metodo: "auto",
    estado: "activo",
    refresco: 'POST /api/admin/fiscal-ingest {"type":"ley","clave":"LIVA"}',
    autoridad: "Cámara de Diputados (texto vigente)",
  },
  {
    clave: "CFF",
    nombre: "Código Fiscal de la Federación",
    capa: "narrativa",
    cadencia: "por-publicacion",
    metodo: "auto",
    estado: "activo",
    refresco: 'POST /api/admin/fiscal-ingest {"type":"ley","clave":"CFF"}',
    autoridad: "Cámara de Diputados (texto vigente)",
  },
  {
    clave: "LIEPS",
    nombre: "Ley del Impuesto Especial sobre Producción y Servicios",
    capa: "narrativa",
    cadencia: "anual",
    metodo: "auto",
    estado: "activo",
    refresco: 'POST /api/admin/fiscal-ingest {"type":"ley","clave":"LIEPS"}',
    autoridad: "Cámara de Diputados (texto vigente)",
    notas: "Cuotas IEPS (combustibles, tabaco, bebidas) se actualizan por inflación cada año.",
  },
  // ── Reglamentos y leyes de nómina — Fase 1 del copiloto (auto) ───────────
  {
    clave: "RLISR",
    nombre: "Reglamento de la Ley del ISR",
    capa: "narrativa",
    cadencia: "por-publicacion",
    metodo: "auto",
    estado: "activo",
    refresco: 'POST /api/admin/fiscal-ingest {"type":"ley","clave":"RLISR"}',
    autoridad: "Cámara de Diputados (texto vigente)",
    notas: "Donde viven las respuestas de a diario que la ley no da (p.ej. 3-A: la pickup no es automóvil). Archivo de Diputados con fecha en el nombre (Reg_LISR_060516).",
  },
  {
    clave: "RLIVA",
    nombre: "Reglamento de la Ley del IVA",
    capa: "narrativa",
    cadencia: "por-publicacion",
    metodo: "auto",
    estado: "activo",
    refresco: 'POST /api/admin/fiscal-ingest {"type":"ley","clave":"RLIVA"}',
    autoridad: "Cámara de Diputados (texto vigente)",
    notas: "Art. 3: retención de dos terceras partes del IVA a personas físicas. Archivo Reg_LIVA_250914.",
  },
  {
    clave: "RCFF",
    nombre: "Reglamento del Código Fiscal de la Federación",
    capa: "narrativa",
    cadencia: "por-publicacion",
    metodo: "auto",
    estado: "activo",
    refresco: 'POST /api/admin/fiscal-ingest {"type":"ley","clave":"RCFF"}',
    autoridad: "Cámara de Diputados (texto vigente)",
    notas: "Avisos al RFC, plazos, requisitos de contabilidad.",
  },
  {
    clave: "LSS",
    nombre: "Ley del Seguro Social",
    capa: "narrativa",
    cadencia: "por-publicacion",
    metodo: "auto",
    estado: "activo",
    refresco: 'POST /api/admin/fiscal-ingest {"type":"ley","clave":"LSS"}',
    autoridad: "Cámara de Diputados (texto vigente)",
    notas: "Cuotas obrero-patronales, altas/bajas, salario base de cotización. Numera artículos «5 A», «15 B».",
  },
  {
    clave: "LINFONAVIT",
    nombre: "Ley del INFONAVIT",
    capa: "narrativa",
    cadencia: "por-publicacion",
    metodo: "auto",
    estado: "activo",
    refresco: 'POST /api/admin/fiscal-ingest {"type":"ley","clave":"LINFONAVIT"}',
    autoridad: "Cámara de Diputados (texto vigente)",
    notas: "Aportaciones y descuentos de vivienda. Archivo en pdf_mov/ (Diputados).",
  },
  {
    clave: "LFT",
    nombre: "Ley Federal del Trabajo",
    capa: "narrativa",
    cadencia: "por-publicacion",
    metodo: "auto",
    estado: "activo",
    refresco: 'POST /api/admin/fiscal-ingest {"type":"ley","clave":"LFT"}',
    autoridad: "Cámara de Diputados (texto vigente)",
    notas: "Aguinaldo, vacaciones, prima, finiquito/liquidación, PTU.",
  },
  {
    clave: "GUIA-PAGOS",
    nombre: "Guía de llenado del complemento de pagos (REP)",
    capa: "narrativa",
    cadencia: "por-publicacion",
    metodo: "auto",
    estado: "activo",
    refresco: 'POST /api/admin/fiscal-ingest {"type":"doc","clave":"GUIA-PAGOS"}',
    autoridad: "SAT",
  },
  {
    clave: "GUIA-CFDI-GLOBAL",
    nombre: "Guía de llenado del CFDI global",
    capa: "narrativa",
    cadencia: "por-publicacion",
    metodo: "auto",
    estado: "activo",
    refresco: 'POST /api/admin/fiscal-ingest {"type":"doc","clave":"GUIA-CFDI-GLOBAL"}',
    autoridad: "SAT",
  },
  {
    clave: "RMF",
    nombre: "Resolución Miscelánea Fiscal (+ resoluciones de modificaciones)",
    capa: "narrativa",
    cadencia: "anual",
    metodo: "semiauto",
    estado: "pendiente",
    refresco: "Descargar PDF del DOF (bloquea bots) y subir: fiscal:ingest-doc -- RMF-2026 --file <ruta>",
    autoridad: "SAT / DOF",
    notas: "Anual (dic/ene) + 1ª, 2ª… modificaciones durante el año. Requiere PDF manual.",
  },
  {
    clave: "RFA",
    nombre: "Resolución de Facilidades Administrativas (AGAPES, autotransporte)",
    capa: "narrativa",
    cadencia: "anual",
    metodo: "manual",
    estado: "pendiente",
    refresco: "Descargar del DOF y subir como doc; aún no en el catálogo de ingesta.",
    autoridad: "SAT / DOF",
  },

  // ── Capa de reglas (catálogo versionado en git) ──────────────────────────────
  {
    clave: "TARIFAS-ISR",
    nombre: "Tarifas ISR (mensual/anual) y subsidio al empleo",
    capa: "reglas",
    cadencia: "anual",
    metodo: "semiauto",
    estado: "activo",
    refresco: "PR a src/lib/fiscal/tarifas.ts; el cotejo semanal (cotejo-fiscal) y `npm run fiscal:valores` comparan contra el PDF del Anexo 8 en el minisitio del SAT.",
    autoridad: "SAT (Anexo 8 RMF)",
    notas: "Se actualizan cuando la inflación acumulada supera 10% (Art. 152) o por reforma.",
  },
  {
    clave: "ISN",
    nombre: "Impuesto Sobre Nómina — tasas por entidad",
    capa: "reglas",
    cadencia: "anual",
    metodo: "manual",
    estado: "activo",
    refresco: "PR a src/lib/fiscal/rules/catalog.ts (investigar Leyes de Ingresos estatales).",
    autoridad: "Congresos / Secretarías de Finanzas estatales",
    notas: "Cada estado fija su tasa en su Ley de Ingresos anual (dic). Varias subieron en 2025-2026.",
  },
  {
    clave: "UMA",
    nombre: "Unidad de Medida y Actualización",
    capa: "reglas",
    cadencia: "anual",
    metodo: "semiauto",
    estado: "activo",
    refresco: "PR a catalog.ts (clave uma.valor); cerrar vigencia anterior y agregar la nueva (1-feb). Cotejo contra la API de indicadores del INEGI cuando hay INEGI_TOKEN.",
    autoridad: "INEGI",
    notas: "Vigor 1-feb cada año. Base de multas, topes y exenciones (p.ej. AGAPES).",
  },
  {
    clave: "SALARIO-MINIMO",
    nombre: "Salario mínimo general y de frontera",
    capa: "reglas",
    cadencia: "anual",
    metodo: "manual",
    estado: "activo",
    refresco: "PR a catalog.ts (salario_minimo.general / .frontera); vigor 1-ene.",
    autoridad: "CONASAMI",
    notas: "Vigor 1-ene. Tope del subsidio al empleo y de previsión social.",
  },
  {
    clave: "MULTAS-CFF",
    nombre: "Multas y cantidades actualizadas del CFF (Anexo 5 RMF)",
    capa: "reglas",
    cadencia: "anual",
    metodo: "semiauto",
    estado: "activo",
    refresco: "`npm run fiscal:valores -- --ejercicio <Y>` descarga el Anexo 5 del minisitio del SAT y regenera src/lib/fiscal/datos/multas-cff-<Y>.json; el workflow valores-fiscales.yml abre el PR. Cotejo semanal contra el PDF.",
    autoridad: "SAT (Anexo 5 RMF, DOF)",
    notas: "Se actualizan cuando la inflación acumulada supera 10 % (Art. 17-A CFF) y por reformas al CFF; el Anexo puede modificarse a mitad de año.",
  },
  {
    clave: "RECARGOS-LIF",
    nombre: "Tasa de recargos (prórroga LIF; mora Art. 21 CFF; pago a plazos)",
    capa: "reglas",
    cadencia: "anual",
    metodo: "auto",
    estado: "activo",
    refresco: "`npm run fiscal:valores` lee la LIF del ejercicio en diputados.gob.mx y regenera src/lib/fiscal/datos/recargos-<Y>.json; PR vía valores-fiscales.yml.",
    autoridad: "Congreso de la Unión (LIF, DOF) / Cámara de Diputados",
    notas: "El artículo cambia de número entre ejercicios (Art. 8 hasta 2025, Art. 11 en 2026); se localiza por contenido.",
  },
  {
    clave: "DEPRECIACION",
    nombre: "Tasas de depreciación / deducción de inversiones (Art. 34-35 LISR)",
    capa: "reglas",
    cadencia: "por-publicacion",
    metodo: "semiauto",
    estado: "activo",
    refresco: "PR a catalog.ts (verificar contra el texto de LISR ya ingerido).",
    autoridad: "LISR",
  },

  // ── Factores externos (consumidos por cálculos; pendientes de cablear) ───────
  {
    clave: "INPC",
    nombre: "Índice Nacional de Precios al Consumidor",
    capa: "reglas",
    cadencia: "mensual",
    metodo: "semiauto",
    estado: "activo",
    refresco: "PR a src/lib/fiscal/inpc.ts (+ suplemento en actualizacion.ts) con el INPC del mes (~día 10); el cron inpc-refresh.yml avisa si se atrasa.",
    autoridad: "INEGI (DOF)",
    notas: "Publicado ~día 10 y 25. Base de la actualización por inflación (depreciación, pérdidas, CUFIN).",
  },
  {
    clave: "TIPO-CAMBIO-DOF",
    nombre: "Tipo de cambio para solventar obligaciones (DOF)",
    capa: "reglas",
    cadencia: "diaria",
    metodo: "semiauto",
    estado: "pendiente",
    refresco: "Cron diario (pendiente): leer el TC del DOF y guardarlo en DB (para CFDIs en moneda extranjera). El auditor ya valida que un CFDI no-MXN traiga TC (check cfdi.moneda_extranjera_sin_tc).",
    autoridad: "Banxico / DOF",
  },
  {
    clave: "CATALOGOS-SAT",
    nombre: "Catálogos del CFDI 4.0 (c_ClaveProdServ, c_RegimenFiscal, c_UsoCFDI…)",
    capa: "reglas",
    cadencia: "por-publicacion",
    metodo: "manual",
    estado: "pendiente",
    refresco: "Actualizar catálogos cuando el SAT publique nueva versión del Anexo 20.",
    autoridad: "SAT",
  },
];

/** Sources a cron can re-ingest without intervention, already wired up. */
export function fuentesAuto(): FuenteFiscal[] {
  return FUENTES.filter((f) => f.metodo === "auto" && f.estado === "activo");
}

/** Sources matching a cadencia (e.g. all "anual" to review each ejercicio). */
export function fuentesPorCadencia(c: Cadencia): FuenteFiscal[] {
  return FUENTES.filter((f) => f.cadencia === c);
}

/** Identified-but-not-yet-wired sources (the brain's freshness backlog). */
export function fuentesPendientes(): FuenteFiscal[] {
  return FUENTES.filter((f) => f.estado === "pendiente");
}
