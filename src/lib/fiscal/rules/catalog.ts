// ─────────────────────────────────────────────────────────────────────────────
// Seed catalog of structured fiscal rules.
//
// `verificado: true`  → checked against the authoritative source text.
// `verificado: false` → AI-derived / pending review; consumers must surface it.
//
// Each rule carries a `fundamento`. The `chunkId` link to the narrative layer is
// added when the ingestion pipeline cross-links them; until then the article ref
// is enough to cite.
//
// IMPORTANT: never edit a rule's value in place when the law changes — close its
// vigencia (`vigenciaHasta`) and append a superseding rule with the same `clave`
// and a new `vigenciaDesde`. getRule() resolves the one in force for a date.
// ─────────────────────────────────────────────────────────────────────────────

import type { FiscalRule } from "./types";

export const CATALOGO: FiscalRule[] = [
  // ── IVA ────────────────────────────────────────────────────────────────────
  {
    clave: "iva.tasa.general",
    tipo: "RATE",
    valor: 0.16,
    unidad: "porcentaje",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
    vigenciaDesde: "2014-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "LIVA", articulo: "1", fraccion: "I" },
    verificado: true,
  },
  {
    clave: "iva.tasa.exportacion",
    tipo: "RATE",
    valor: 0.0,
    unidad: "porcentaje",
    aplicabilidad: { regimenes: "*", actividades: ["EXPORTACION"], tipoPersona: "*" },
    vigenciaDesde: "2014-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "LIVA", articulo: "29" },
    verificado: true,
  },
  {
    // Construcción/enajenación de casa habitación: exenta de IVA (el constructor
    // que aporta mano de obra y materiales presta servicio exento).
    clave: "iva.exencion.casa_habitacion",
    tipo: "EXEMPTION",
    valor: true,
    aplicabilidad: { regimenes: "*", actividades: ["CONSTRUCCION"], tipoPersona: "*" },
    vigenciaDesde: "2014-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "LIVA", articulo: "9", fraccion: "II" },
    verificado: true,
  },

  // ── ISR — deducciones / topes ────────────────────────────────────────────────
  {
    // Tope de MOI deducible para automóviles (de combustión).
    clave: "isr.deduccion.auto.tope_moi",
    tipo: "CAP",
    valor: 175000,
    unidad: "MXN",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
    vigenciaDesde: "2014-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "LISR", articulo: "36", fraccion: "II" },
    verificado: true,
  },
  {
    // Tope de MOI deducible para automóviles eléctricos / híbridos. Verificar el
    // monto vigente (decreto/RMF) antes de marcar verificado.
    clave: "isr.deduccion.auto_electrico.tope_moi",
    tipo: "CAP",
    valor: 250000,
    unidad: "MXN",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
    vigenciaDesde: "2017-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "LISR", articulo: "36", fraccion: "II" },
    verificado: false,
  },
  {
    // Consumos en restaurantes: deducibles sólo al 8.5% (pago con tarjeta).
    clave: "isr.deduccion.restaurante.porcentaje",
    tipo: "RATE",
    valor: 0.085,
    unidad: "porcentaje",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
    vigenciaDesde: "2014-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "LISR", articulo: "28", fraccion: "XX" },
    verificado: true,
  },
  {
    // Pagos en efectivo > este monto no son deducibles (salvo combustible, que
    // exige medio electrónico a cualquier monto — ver regla siguiente).
    clave: "isr.deduccion.limite_efectivo",
    tipo: "THRESHOLD",
    valor: 2000,
    unidad: "MXN",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
    vigenciaDesde: "2014-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "LISR", articulo: "27", fraccion: "III" },
    verificado: true,
  },
  {
    // Combustible: deducible sólo si se paga con medio electrónico, a cualquier
    // monto (incluso < $2,000).
    clave: "isr.deduccion.combustible.requiere_medio_electronico",
    tipo: "OBLIGATION",
    valor: true,
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
    vigenciaDesde: "2014-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "LISR", articulo: "27", fraccion: "III" },
    verificado: true,
  },

  // ── ISN — Impuesto Sobre Nómina (estatal) ───────────────────────────────────
  // Tasa estatal sobre erogaciones por remuneraciones al trabajo personal. Cada
  // entidad la fija en su Ley de Hacienda / Código Fiscal — varía ~1%–4% y cambia
  // por ejercicio. Sembradas como verificado:false hasta ingerir cada ley estatal.
  {
    clave: "isn.tasa",
    tipo: "RATE",
    valor: 0.03,
    unidad: "porcentaje",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*", entidad: ["CMX"] },
    vigenciaDesde: "2024-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "Código Fiscal de la CDMX", articulo: "158" },
    verificado: false,
  },
  {
    clave: "isn.tasa",
    tipo: "RATE",
    valor: 0.03,
    unidad: "porcentaje",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*", entidad: ["NLE"] },
    vigenciaDesde: "2024-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "Ley de Hacienda del Estado de Nuevo León", articulo: "154" },
    verificado: false,
  },
  {
    clave: "isn.tasa",
    tipo: "RATE",
    valor: 0.03,
    unidad: "porcentaje",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*", entidad: ["MEX"] },
    vigenciaDesde: "2024-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "Código Financiero del Estado de México", articulo: "56" },
    verificado: false,
  },
  {
    clave: "isn.tasa",
    tipo: "RATE",
    valor: 0.02,
    unidad: "porcentaje",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*", entidad: ["JAL"] },
    vigenciaDesde: "2024-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "Ley de Hacienda del Estado de Jalisco", articulo: "41" },
    verificado: false,
  },
  {
    clave: "isn.tasa",
    tipo: "RATE",
    valor: 0.03,
    unidad: "porcentaje",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*", entidad: ["GUA"] },
    vigenciaDesde: "2024-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "Ley de Hacienda para el Estado de Guanajuato", articulo: "9" },
    verificado: false,
  },

  // ── ISR — depreciación (deducción de inversiones) ────────────────────────────
  {
    // Tasas máximas de depreciación por tipo de activo. Tabla pendiente de
    // verificar contra el texto completo del Art. 34 antes de promover.
    clave: "isr.depreciacion.tasas",
    tipo: "DEPRECIATION",
    valor: {
      equipo_computo: 0.3,
      equipo_transporte: 0.25,
      mobiliario_oficina: 0.1,
      maquinaria_general: 0.1,
      construcciones: 0.05,
    },
    unidad: "porcentaje",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
    vigenciaDesde: "2014-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "LISR", articulo: "34" },
    verificado: false,
  },
];
