// ─────────────────────────────────────────────────────────────────────────────
// Preguntas doradas del copiloto fiscal — Fase 0 del plan «que razone como los
// mejores contadores».
//
// Cada pregunta trae el FUNDAMENTO que un contador senior citaría. Con eso se
// mide, sin opiniones: ¿la KB lo recuperó (top-6)? ¿la respuesta lo cita?
// ¿inventa artículos que la KB no devolvió? El juez LLM sólo califica lo que
// no se puede medir con una regex (si el fundamento se USÓ bien).
//
// Formato de cita = el mismo que emite search.ts (buildCita): «Art. 27 LISR»,
// «Regla 2.7.1.32 RMF-2026». Basta con que UNO de los fundamentos aparezca.
//
// `nota` es para el revisor humano (Juan): dónde el fundamento tiene matiz.
// Las 40 de Juan (las que un cliente pregunta cada mes) se agregan aquí mismo
// con ids j01…j40.
// ─────────────────────────────────────────────────────────────────────────────

export interface PreguntaEval {
  id: string;
  tema: string;
  pregunta: string;
  /** Citas aceptables; basta una. Formato de buildCita. */
  fundamentos: string[];
  /** Régimen del contribuyente sintético: "601" (PM general) | "626" (RESICO PF) | "612" (PF act. empresarial). */
  regimen?: "601" | "626" | "612";
  nota?: string;
}

export const PREGUNTAS_EVAL: PreguntaEval[] = [
  // ── Deducciones (LISR) ──────────────────────────────────────────────────────
  { id: "c01", tema: "deducciones", pregunta: "¿Puedo deducir la gasolina que pagué en efectivo?", fundamentos: ["Art. 27 LISR"], nota: "Fracción III: combustibles siempre con medio electrónico, sin importar el monto." },
  { id: "c02", tema: "deducciones", pregunta: "¿Hasta qué monto puedo pagar un gasto en efectivo y que siga siendo deducible?", fundamentos: ["Art. 27 LISR"], nota: "$2,000 (fracción III)." },
  { id: "c03", tema: "deducciones", pregunta: "Compré un automóvil para la empresa, ¿cuánto puedo deducir?", fundamentos: ["Art. 36 LISR", "Art. 34 LISR"], nota: "Tope $175,000 MOI (36-II); se deduce vía inversión, no de golpe." },
  { id: "c04", tema: "deducciones", pregunta: "¿Qué porcentaje de los consumos en restaurantes es deducible?", fundamentos: ["Art. 28 LISR"], nota: "91.5% NO deducible (fracción XX); pagado con tarjeta." },
  { id: "c05", tema: "deducciones", pregunta: "¿Puedo deducir los sueldos si no timbré los recibos de nómina?", fundamentos: ["Art. 27 LISR", "Art. 99 LISR"], nota: "Fracción V del 27: el CFDI de nómina es requisito." },
  { id: "c06", tema: "deducciones", pregunta: "¿Cuánto puedo deducir por donativos a una donataria autorizada?", fundamentos: ["Art. 27 LISR"], nota: "Fracción I: hasta 7% de la utilidad fiscal del ejercicio anterior." },
  { id: "c07", tema: "deducciones", pregunta: "¿A qué porcentaje deprecio el equipo de cómputo y el mobiliario?", fundamentos: ["Art. 34 LISR"], nota: "30% cómputo, 10% mobiliario." },
  { id: "c08", tema: "deducciones", pregunta: "Compré mercancía para revender, ¿la deduzco cuando la pago o cuando la vendo?", fundamentos: ["Art. 39 LISR"], nota: "Costo de lo vendido: al enajenar." },
  { id: "c09", tema: "deducciones", pregunta: "¿La PTU que pagué es deducible?", fundamentos: ["Art. 28 LISR", "Art. 9 LISR"], nota: "No deducible (28-XXVI) pero se disminuye de la utilidad fiscal (9)." },
  { id: "c10", tema: "deducciones", pregunta: "¿Qué deducciones personales puedo meter en mi declaración anual como persona física?", fundamentos: ["Art. 151 LISR"], regimen: "612" },

  // ── Ingresos y momento de acumulación ──────────────────────────────────────
  { id: "c11", tema: "ingresos", pregunta: "Facturé en junio pero me pagaron en agosto, ¿en qué mes acumulo el ingreso para ISR?", fundamentos: ["Art. 17 LISR"], nota: "PM: devengado — al expedir el CFDI (junio)." },
  { id: "c12", tema: "ingresos", pregunta: "Soy persona física con actividad empresarial, ¿acumulo cuando facturo o cuando cobro?", fundamentos: ["Art. 102 LISR"], regimen: "612", nota: "PF: flujo de efectivo (102)." },
  { id: "c13", tema: "ingresos", pregunta: "¿Qué es el ajuste anual por inflación y quién debe calcularlo?", fundamentos: ["Art. 44 LISR"] },
  { id: "c14", tema: "ingresos", pregunta: "Si la empresa reparte dividendos, ¿qué ISR adicional paga el socio persona física?", fundamentos: ["Art. 140 LISR"], nota: "10% adicional definitivo." },

  // ── IVA ────────────────────────────────────────────────────────────────────
  { id: "c15", tema: "iva", pregunta: "¿El IVA se causa cuando facturo o cuando me pagan?", fundamentos: ["Art. 1-B LIVA", "Art. 11 LIVA"], nota: "Flujo: al cobro efectivo." },
  { id: "c16", tema: "iva", pregunta: "¿Qué requisitos debe cumplir el IVA de mis compras para poder acreditarlo?", fundamentos: ["Art. 5 LIVA"] },
  { id: "c17", tema: "iva", pregunta: "Como persona moral, ¿cuánto IVA retengo a una persona física que me presta servicios profesionales?", fundamentos: ["Art. 1-A LIVA"], nota: "Dos terceras partes (RLIVA Art. 3, que aún no está en la KB)." },
  { id: "c18", tema: "iva", pregunta: "¿Qué actividades están exentas de IVA?", fundamentos: ["Art. 9 LIVA", "Art. 15 LIVA"] },
  { id: "c19", tema: "iva", pregunta: "¿Qué productos llevan IVA a tasa 0%?", fundamentos: ["Art. 2-A LIVA"] },
  { id: "c20", tema: "iva", pregunta: "¿Qué es la DIOT y estoy obligado a presentarla?", fundamentos: ["Art. 32 LIVA"], nota: "Fracción VIII." },
  { id: "c21", tema: "iva", pregunta: "Tengo saldo a favor de IVA, ¿puedo compensarlo contra el ISR que debo?", fundamentos: ["Art. 23 CFF", "Art. 6 LIVA"], nota: "No: compensación sólo del mismo impuesto desde 2019; IVA a favor se acredita o se pide en devolución." },

  // ── Retenciones y pagos provisionales ──────────────────────────────────────
  { id: "c22", tema: "retenciones", pregunta: "¿Cuánto ISR retengo a una persona física que me factura honorarios?", fundamentos: ["Art. 106 LISR"], nota: "10% (último párrafo)." },
  { id: "c23", tema: "retenciones", pregunta: "Rento una oficina a una persona física, ¿le retengo ISR?", fundamentos: ["Art. 116 LISR"], nota: "10%." },
  { id: "c24", tema: "retenciones", pregunta: "¿Cómo calculo el pago provisional de ISR de mi persona moral?", fundamentos: ["Art. 14 LISR"], nota: "Coeficiente de utilidad." },
  { id: "c25", tema: "retenciones", pregunta: "¿Qué obligaciones tengo como patrón respecto al ISR de mis trabajadores?", fundamentos: ["Art. 96 LISR", "Art. 99 LISR"] },
  { id: "c26", tema: "retenciones", pregunta: "¿Cuál es la tasa de ISR de una persona moral?", fundamentos: ["Art. 9 LISR"], nota: "30%." },

  // ── RESICO ─────────────────────────────────────────────────────────────────
  { id: "c27", tema: "resico", pregunta: "¿Quién puede tributar en RESICO como persona física y cuál es el tope de ingresos?", fundamentos: ["Art. 113-E LISR"], regimen: "626", nota: "$3,500,000." },
  { id: "c28", tema: "resico", pregunta: "¿Qué tasa de ISR pago en RESICO según mis ingresos del mes?", fundamentos: ["Art. 113-E LISR"], regimen: "626", nota: "1% a 2.5%." },
  { id: "c29", tema: "resico", pregunta: "Le facturo a una persona moral estando en RESICO, ¿me retiene ISR?", fundamentos: ["Art. 113-J LISR"], regimen: "626", nota: "1.25%." },

  // ── CFDI y CFF ─────────────────────────────────────────────────────────────
  { id: "c30", tema: "cfdi", pregunta: "¿Qué datos debe llevar obligatoriamente un CFDI?", fundamentos: ["Art. 29-A CFF"] },
  { id: "c31", tema: "cfdi", pregunta: "¿Puedo cancelar una factura de un ejercicio que ya cerró?", fundamentos: ["Art. 29-A CFF"], nota: "Sólo en el ejercicio en que se expidió (cuarto párrafo), salvo RMF." },
  { id: "c32", tema: "cfdi", pregunta: "¿Cuál es el plazo para emitir el complemento de pago (REP) de una factura PPD?", fundamentos: ["Regla 2.7.1.32 RMF-2026", "Art. 29-A CFF"], nota: "Quinto día natural del mes siguiente al pago (RMF). Si la RMF no está ingerida, este ítem falla por diseño." },
  { id: "c33", tema: "cff", pregunta: "El SAT me restringió el certificado de sello digital, ¿qué hago?", fundamentos: ["Art. 17-H Bis CFF", "Art. 17-H CFF"] },
  { id: "c34", tema: "cff", pregunta: "¿Estoy obligado a tener buzón tributario?", fundamentos: ["Art. 17-K CFF"] },
  { id: "c35", tema: "cff", pregunta: "¿Cuánto tiempo debo conservar mi contabilidad?", fundamentos: ["Art. 30 CFF"], nota: "5 años." },
  { id: "c36", tema: "cff", pregunta: "Pedí una devolución de saldo a favor, ¿en cuántos días debe pagar el SAT?", fundamentos: ["Art. 22 CFF"], nota: "40 días." },
  { id: "c37", tema: "cff", pregunta: "Mi proveedor apareció en la lista del 69-B, ¿qué pasa con las facturas que ya deduje?", fundamentos: ["Art. 69-B CFF"] },
  { id: "c38", tema: "cff", pregunta: "¿Cómo se calculan los recargos por pagar una declaración tarde?", fundamentos: ["Art. 21 CFF"] },
  { id: "c39", tema: "cff", pregunta: "Presenté mi declaración con un error, ¿puedo corregirla y cuántas veces?", fundamentos: ["Art. 32 CFF"], nota: "Complementarias: hasta 3." },
  { id: "c40", tema: "cff", pregunta: "¿Qué es la opinión de cumplimiento y para qué me la piden?", fundamentos: ["Art. 32-D CFF"] },
];
