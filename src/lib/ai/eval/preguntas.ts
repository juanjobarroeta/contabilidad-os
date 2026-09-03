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
  { id: "c17", tema: "iva", pregunta: "Como persona moral, ¿cuánto IVA retengo a una persona física que me presta servicios profesionales?", fundamentos: ["Art. 1-A LIVA", "Art. 3 RLIVA"], nota: "Dos terceras partes (RLIVA 3)." },
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

  // ── Lo que un cliente pregunta cada mes (j01–j40) ───────────────────────────
  // Redactadas con el perfil «cliente al contador»: plazos, qué pasa si no,
  // nómina, facturas del día a día, plataformas, SAT tocando la puerta.
  // Pendientes de revisión de Juan (nota en cada una con el matiz).

  // plazos y consecuencias
  { id: "j01", tema: "plazos", pregunta: "¿Cuándo vence mi declaración mensual de IVA e ISR?", fundamentos: ["Art. 5-D LIVA", "Art. 14 LISR"], nota: "Día 17 del mes siguiente; la RMF da días adicionales por sexto dígito del RFC." },
  { id: "j02", tema: "plazos", pregunta: "¿Qué pasa si no presento la DIOT de un mes?", fundamentos: ["Art. 81 CFF", "Art. 82 CFF"], nota: "Infracción 81-XXVI y multa 82-XXVI." },
  { id: "j03", tema: "plazos", pregunta: "Si pago tarde una declaración, ¿además de recargos hay actualización?", fundamentos: ["Art. 17-A CFF", "Art. 21 CFF"] },
  { id: "j04", tema: "plazos", pregunta: "Debo mucho ISR, ¿puedo pagarlo en parcialidades?", fundamentos: ["Art. 66 CFF", "Art. 66-A CFF"], nota: "Hasta 36 meses; 20% inicial." },
  { id: "j05", tema: "plazos", pregunta: "¿Cuánto tiempo tiene el SAT para revisarme un ejercicio ya declarado?", fundamentos: ["Art. 67 CFF"], nota: "Caducidad 5 años (10 en supuestos)." },
  { id: "j06", tema: "plazos", pregunta: "El SAT me mandó una carta invitación por diferencias en mis ingresos, ¿qué hago?", fundamentos: ["Art. 33 CFF", "Art. 42 CFF"], nota: "La carta invitación no es facultad de comprobación (42); es asistencia (33)." },
  { id: "j07", tema: "plazos", pregunta: "Mi empresa dejó de operar, ¿suspendo actividades o tengo que liquidar?", fundamentos: ["Art. 27 CFF", "Art. 12 LISR"] },
  { id: "j08", tema: "plazos", pregunta: "¿Estoy obligado a llevar contabilidad electrónica y enviarla al SAT?", fundamentos: ["Art. 28 CFF"], nota: "Fracciones III y IV." },

  // facturas del día a día
  { id: "j09", tema: "cfdi", pregunta: "Vendo al público en general sin pedir RFC, ¿cómo facturo esas ventas?", fundamentos: ["Art. 29-A CFF", "Regla 2.7.1.21 RMF-2026"], nota: "RFC genérico XAXX010101000 y factura global (RMF). Si la RMF no está ingerida, el hit cae al 29-A." },
  { id: "j10", tema: "cfdi", pregunta: "Un cliente me devolvió mercancía que ya facturé, ¿qué documento emito?", fundamentos: ["Art. 25 LISR", "Art. 29-A CFF"], nota: "CFDI de egreso (nota de crédito) relacionado; la devolución es deducible (25-I)." },
  { id: "j11", tema: "cfdi", pregunta: "Mi cliente quiere que cancele una factura que ya me pagó, ¿puedo?", fundamentos: ["Art. 29-A CFF"], nota: "Requiere aceptación del receptor salvo excepciones de la RMF (2.7.1.35)." },
  { id: "j12", tema: "cfdi", pregunta: "Recibí una factura con mi RFC mal escrito, ¿la puedo deducir?", fundamentos: ["Art. 27 LISR", "Art. 29-A CFF"], nota: "No: el comprobante debe cumplir requisitos (27-III, 29-A); pedir sustitución." },
  { id: "j13", tema: "cfdi", pregunta: "¿En qué momento debo expedir la factura: al entregar la mercancía o al cobrar?", fundamentos: ["Art. 29 CFF", "Art. 17 LISR"] },
  { id: "j14", tema: "cfdi", pregunta: "Me hicieron una factura PPD y nunca me pagaron; el cliente desapareció. ¿Qué hago?", fundamentos: ["Art. 27 LISR", "Art. 29-A CFF"], nota: "Crédito incobrable (27-XV) tras el plazo/gestión; no se cancela el CFDI por falta de pago." },

  // deducciones que pregunta el cliente
  { id: "j15", tema: "deducciones", pregunta: "¿Puedo deducir el celular y el internet que uso para el negocio?", fundamentos: ["Art. 27 LISR"], nota: "Estrictamente indispensable (27-I) y con CFDI." },
  { id: "j16", tema: "deducciones", pregunta: "Voy a un viaje de trabajo, ¿hay tope para deducir comidas y hotel?", fundamentos: ["Art. 28 LISR"], nota: "Viáticos 28-V: $750/día alimentación nacional, $1,500 extranjero; hospedaje $3,850 extranjero; renta de auto $850." },
  { id: "j17", tema: "deducciones", pregunta: "Pago la renta de mi local a una persona física que no me da factura, ¿la puedo deducir?", fundamentos: ["Art. 27 LISR", "Art. 116 LISR"], nota: "Sin CFDI no; y le corresponde retención del 10%." },
  { id: "j18", tema: "deducciones", pregunta: "¿Se pueden deducir los intereses de un préstamo bancario de la empresa?", fundamentos: ["Art. 25 LISR", "Art. 27 LISR"], nota: "Intereses devengados (25-VII), a tasa de mercado y para fines del negocio (27-VII)." },
  { id: "j19", tema: "deducciones", pregunta: "Un cliente no me pagó y ya pasó más de un año, ¿puedo deducir la pérdida?", fundamentos: ["Art. 27 LISR"], nota: "Créditos incobrables 27-XV: plazo de prescripción o notoria imposibilidad de cobro." },
  { id: "j20", tema: "deducciones", pregunta: "¿Puedo deducir los gastos que hice antes de constituir la empresa?", fundamentos: ["Art. 32 LISR", "Art. 33 LISR"], nota: "Gastos preoperativos = inversión (32), 10% anual (33)." },
  { id: "j21", tema: "deducciones", pregunta: "Compré una camioneta pickup para el negocio, ¿aplica el tope de $175,000?", fundamentos: ["Art. 36 LISR", "Art. 3-A RLISR"], nota: "El tope es para automóviles; la pickup de carga no es automóvil (RLISR 3-A)." },
  { id: "j22", tema: "deducciones", pregunta: "Tengo pérdidas fiscales de años anteriores, ¿las puedo aplicar este año?", fundamentos: ["Art. 57 LISR"], nota: "Hasta 10 ejercicios, actualizadas." },

  // nómina e IMSS
  { id: "j23", tema: "nomina", pregunta: "¿Qué necesito para que la nómina de mis empleados sea deducible?", fundamentos: ["Art. 27 LISR"], nota: "27-V: CFDI de nómina y entero de retenciones; IMSS pagado." },
  { id: "j24", tema: "nomina", pregunta: "¿Qué pasa si timbro la nómina tarde?", fundamentos: ["Art. 99 LISR", "Art. 27 LISR"], nota: "Obligación de expedir CFDI (99-III); RMF permite timbrar antes de la anual para no perder la deducción." },
  { id: "j25", tema: "nomina", pregunta: "¿Puedo deducir el seguro de gastos médicos que pago a mis empleados?", fundamentos: ["Art. 27 LISR"], nota: "Previsión social 27-XI, con generalidad." },
  { id: "j26", tema: "nomina", pregunta: "¿Los vales de despensa son deducibles?", fundamentos: ["Art. 27 LISR", "Art. 28 LISR"], nota: "Sí vía monedero electrónico autorizado (27-XI); la parte exenta para el trabajador se deduce al 53%/47% (28-XXX)." },
  { id: "j27", tema: "nomina", pregunta: "¿Qué parte del aguinaldo está exenta de ISR para el trabajador?", fundamentos: ["Art. 93 LISR", "Art. 87 LFT"], nota: "30 UMA exentas (93-XIV); 15 días mínimo (LFT 87)." },
  { id: "j28", tema: "nomina", pregunta: "Un trabajador renunció, ¿qué parte de su finiquito está exenta de ISR?", fundamentos: ["Art. 93 LISR", "Art. 95 LISR", "Art. 162 LFT"], nota: "90 UMA por año de servicio (93-XIII); retención por separación (95); prima de antigüedad (LFT 162)." },
  { id: "j29", tema: "nomina", pregunta: "¿Le retengo ISR a un empleado que gana el salario mínimo?", fundamentos: ["Art. 96 LISR"], nota: "No se retiene a quien percibe salario mínimo." },
  { id: "j30", tema: "nomina", pregunta: "Contraté a un consultor que vive en el extranjero, ¿le retengo algo?", fundamentos: ["Art. 153 LISR"], nota: "Título V: depende de fuente de riqueza y tratado." },

  // IVA del día a día
  { id: "j31", tema: "iva", pregunta: "¿Por qué este mes me sale IVA a favor y qué puedo hacer con él?", fundamentos: ["Art. 4 LIVA", "Art. 6 LIVA"], nota: "Acreditable > trasladado; se acredita en meses siguientes o se pide devolución." },
  { id: "j32", tema: "iva", pregunta: "Vendo a un cliente en Estados Unidos, ¿le cobro IVA?", fundamentos: ["Art. 29 LIVA"], nota: "Exportación: tasa 0%." },
  { id: "j33", tema: "iva", pregunta: "Pago publicidad a Google y Meta desde el extranjero, ¿debo pagar IVA por eso?", fundamentos: ["Art. 24 LIVA", "Art. 18-B LIVA"], nota: "Importación de servicios (24-V); los digitales pueden venir con IVA cobrado por la plataforma (18-B y ss.)." },
  { id: "j34", tema: "iva", pregunta: "Vendo por Mercado Libre y Amazon, ¿qué retenciones me hacen?", fundamentos: ["Art. 113-A LISR", "Art. 18-J LIVA"], regimen: "612", nota: "Plataformas: retención de ISR (113-A) e IVA (18-J)." },
  { id: "j35", tema: "iva", pregunta: "Manejo con Uber como persona física, ¿tengo que declarar algo?", fundamentos: ["Art. 113-A LISR", "Art. 113-B LISR"], regimen: "612", nota: "Puede optar por retención definitiva (113-B) bajo tope de ingresos." },

  // dinero entre socios y empresa
  { id: "j36", tema: "socios", pregunta: "La empresa le prestó dinero a un socio, ¿tiene consecuencia fiscal?", fundamentos: ["Art. 140 LISR"], nota: "Dividendo ficto (140-II) salvo requisitos." },
  { id: "j37", tema: "socios", pregunta: "Un socio metió dinero en efectivo a la empresa, ¿hay que avisarle al SAT?", fundamentos: ["Art. 76 LISR"], nota: "76-XVI: préstamos/aportaciones en efectivo > $600,000 se informan en 15 días." },
  { id: "j38", tema: "socios", pregunta: "Me depositaron una cantidad grande en efectivo, ¿el SAT lo va a ver?", fundamentos: ["Art. 55 LISR", "Art. 59 CFF"], nota: "Bancos informan efectivo > $15,000/mes (55-IV); presunción de ingresos por depósitos (59-III)." },
  { id: "j39", tema: "socios", pregunta: "¿Qué es la CUFIN y por qué importa para repartir utilidades?", fundamentos: ["Art. 77 LISR", "Art. 10 LISR"], nota: "Dividendos sin CUFIN pagan ISR corporativo piramidado (10)." },
  { id: "j40", tema: "socios", pregunta: "¿Cada cuánto debo hacer el ajuste anual por inflación si tengo préstamos con socios?", fundamentos: ["Art. 44 LISR", "Art. 45 LISR"], nota: "Anual, sobre créditos y deudas (44–46)." },
];
