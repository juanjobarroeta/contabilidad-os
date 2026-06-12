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

import type { Entidad, FiscalRule } from "./types";

const REGLAS_FEDERALES: FiscalRule[] = [
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

  // ── Valores de referencia (UMA, salario mínimo) ──────────────────────────────
  {
    // UMA vigente desde el 1-feb-2026 (INEGI). En enero 2026 aún aplica la de 2025.
    clave: "uma.valor",
    tipo: "VALOR",
    valor: { diaria: 117.31, mensual: 3566.22, anual: 42794.64 },
    unidad: "MXN",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
    vigenciaDesde: "2026-02-01",
    vigenciaHasta: null,
    fundamento: { ley: "INEGI (DOF)", articulo: "UMA 2026" },
    verificado: true,
  },
  {
    clave: "uma.valor",
    tipo: "VALOR",
    valor: { diaria: 113.14, mensual: 3439.46, anual: 41273.52 },
    unidad: "MXN",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
    vigenciaDesde: "2025-02-01",
    vigenciaHasta: "2026-01-31",
    fundamento: { ley: "INEGI (DOF)", articulo: "UMA 2025" },
    verificado: true,
  },
  {
    // Salario mínimo general (resto del país), por día. Vigente 1-ene-2026.
    clave: "salario_minimo.general",
    tipo: "VALOR",
    valor: 315.04,
    unidad: "MXN",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
    vigenciaDesde: "2026-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "CONASAMI (DOF)", articulo: "SMG 2026" },
    verificado: true,
    nota: "monto diario",
  },
  {
    // Salario mínimo de la Zona Libre de la Frontera Norte (ZLFN), por día.
    clave: "salario_minimo.frontera",
    tipo: "VALOR",
    valor: 440.87,
    unidad: "MXN",
    aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
    vigenciaDesde: "2026-01-01",
    vigenciaHasta: null,
    fundamento: { ley: "CONASAMI (DOF)", articulo: "SM ZLFN 2026" },
    verificado: true,
    nota: "monto diario; aplica solo a municipios de la Zona Libre de la Frontera Norte",
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

// ── ISN — Impuesto Sobre Nómina (estatal), tasa GENERAL 2026 ───────────────────
// Cada entidad fija su tasa en su Ley de Hacienda / Código Fiscal / Ley de
// Ingresos. Varias se fijan ANUALMENTE en la Ley de Ingresos, por lo que ESTAS
// SON LAS TASAS DE 2026 y deben re-verificarse cada ejercicio. Se captura la
// tasa GENERAL; los matices (progresivo, sobretasas, tiers) van en `nota`.
// Investigadas contra fuentes oficiales/secundarias 2025-2026 pero marcadas
// verificado:false hasta ingerir el texto primario de cada ley al KB narrativo.
const ISN_2026: { e: Entidad; tasa: number; ley: string; art: string; nota?: string }[] = [
  { e: "AGU", tasa: 0.025, ley: "Ley de Hacienda del Estado de Aguascalientes", art: "—" },
  { e: "BCN", tasa: 0.0425, ley: "Ley de Hacienda del Estado de Baja California", art: "151-13",
    nota: "1.8% base + sobretasa educación; tasa de liquidación ~4.25%" },
  { e: "BCS", tasa: 0.03, ley: "Ley de Hacienda del Estado de Baja California Sur", art: "—",
    nota: "subió de 2.5% en 2026" },
  { e: "CAM", tasa: 0.03, ley: "Ley de Hacienda del Estado de Campeche", art: "24" },
  { e: "CHP", tasa: 0.03, ley: "Código de la Hacienda Pública del Estado de Chiapas", art: "—",
    nota: "subió de 2% en 2026" },
  { e: "CHH", tasa: 0.04, ley: "Ley de Hacienda del Estado de Chihuahua", art: "—",
    nota: "subió de 3%; + sobretasas extraordinarias (FECHAC 10%, seguridad 5%) sobre ISN al 3%" },
  { e: "CMX", tasa: 0.04, ley: "Código Fiscal de la Ciudad de México", art: "158",
    nota: "subió de 3% (2025); subsidios → 3% micro, 3.5% pequeñas" },
  { e: "COA", tasa: 0.03, ley: "Ley de Hacienda para el Estado de Coahuila de Zaragoza", art: "24" },
  { e: "COL", tasa: 0.03, ley: "Ley de Hacienda del Estado de Colima", art: "41-Q",
    nota: "subió de 2% en 2026" },
  { e: "DUR", tasa: 0.03, ley: "Ley de Hacienda del Estado de Durango", art: "—" },
  { e: "GUA", tasa: 0.03, ley: "Ley de Hacienda para el Estado de Guanajuato", art: "—",
    nota: "tasa fijada en la Ley de Ingresos 2026" },
  { e: "GRO", tasa: 0.03, ley: "Ley de Hacienda del Estado de Guerrero Núm. 419", art: "38",
    nota: "subió de 2% en 2025" },
  { e: "HID", tasa: 0.03, ley: "Ley de Hacienda del Estado de Hidalgo", art: "24" },
  { e: "JAL", tasa: 0.03, ley: "Ley de Hacienda del Estado de Jalisco", art: "41",
    nota: "5% aplica a trabajo NO subordinado (impuesto distinto)" },
  { e: "MEX", tasa: 0.03, ley: "Código Financiero del Estado de México y Municipios", art: "57" },
  { e: "MIC", tasa: 0.03, ley: "Ley de Hacienda del Estado de Michoacán", art: "45" },
  { e: "MOR", tasa: 0.03, ley: "Ley de Hacienda del Estado de Morelos", art: "58-BIS-4",
    nota: "subió de 2.5% en 2026" },
  { e: "NAY", tasa: 0.03, ley: "Ley de Hacienda del Estado de Nayarit", art: "—" },
  { e: "NLE", tasa: 0.03, ley: "Ley de Hacienda del Estado de Nuevo León", art: "157",
    nota: "propuesta de 4% rechazada por el congreso (ene-2026)" },
  { e: "OAX", tasa: 0.03, ley: "Ley Estatal de Hacienda de Oaxaca", art: "—" },
  { e: "PUE", tasa: 0.03, ley: "Ley de Hacienda del Estado de Puebla", art: "—",
    nota: "subió de 2.5% en 2026; tasa en Ley de Ingresos" },
  { e: "QUE", tasa: 0.03, ley: "Ley de Hacienda del Estado de Querétaro", art: "70" },
  { e: "ROO", tasa: 0.04, ley: "Ley del Impuesto Sobre Nóminas del Estado de Quintana Roo", art: "8",
    nota: "subió de 3% en 2026" },
  { e: "SLP", tasa: 0.03, ley: "Ley de Hacienda para el Estado de San Luis Potosí", art: "23" },
  { e: "SIN", tasa: 0.03, ley: "Ley de Hacienda del Estado de Sinaloa", art: "18",
    nota: "PROGRESIVO 2.4%–3.0% por tramos de nómina; 3.0% es el tope" },
  { e: "SON", tasa: 0.03, ley: "Ley de Hacienda del Estado de Sonora", art: "216",
    nota: "+1% adicional para patrones con >100 trabajadores; reducción 50% agro/pesca" },
  { e: "TAB", tasa: 0.04, ley: "Ley de Hacienda del Estado de Tabasco", art: "30",
    nota: "subió de 3% (2025); 3% para sector público" },
  { e: "TAM", tasa: 0.03, ley: "Ley de Hacienda para el Estado de Tamaulipas", art: "49" },
  { e: "TLA", tasa: 0.03, ley: "Código Financiero del Estado de Tlaxcala y sus Municipios", art: "134",
    nota: "incentivos/exenciones hasta 100% por generación de empleo" },
  { e: "VER", tasa: 0.03, ley: "Código Financiero para el Estado de Veracruz", art: "101" },
  { e: "YUC", tasa: 0.0375, ley: "Ley General de Hacienda del Estado de Yucatán", art: "24",
    nota: "subió de 3% (Decreto 138/2025); +1% sector público; estímulo 0.75% micro/pequeñas" },
  { e: "ZAC", tasa: 0.035, ley: "Ley de Hacienda del Estado de Zacatecas", art: "40",
    nota: "subió de 3% (2025); + impuesto adicional para la UAZ" },
];

const REGLAS_ISN: FiscalRule[] = ISN_2026.map((r) => ({
  clave: "isn.tasa",
  tipo: "RATE",
  valor: r.tasa,
  unidad: "porcentaje",
  aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*", entidad: [r.e] },
  // Tasa de 2026 — el ISN se fija por ejercicio; refrescar cada año.
  vigenciaDesde: "2026-01-01",
  vigenciaHasta: null,
  fundamento: { ley: r.ley, articulo: r.art },
  verificado: false,
  nota: r.nota,
}));

export const CATALOGO: FiscalRule[] = [...REGLAS_FEDERALES, ...REGLAS_ISN];
