// ─────────────────────────────────────────────────────────────────────────────
// Score de crédito a partir de los datos fiscales que YA tenemos.
//
// Scorecard TRANSPARENTE (no caja negra): cinco dimensiones con peso fijo,
// cada una con sus razones en lenguaje de contador. La ventaja competitiva no
// es el modelo sino los insumos: declaraciones reales (ingresos declarados,
// puntualidad), opinión del SAT, EFOS y — cuando hay CFDIs — la CONSISTENCIA
// entre lo facturado y lo declarado, que un buró no ve.
//
// Cuando falta un insumo (p. ej. CFDIs aún sin descargar) la dimensión se
// EXCLUYE y su peso se redistribuye proporcionalmente entre las presentes; el
// resultado se marca `provisional` y `cobertura` explica qué faltó. Nunca se
// castiga por dato ausente — se castiga por dato malo.
//
// Módulo PURO: recibe insumos planos, no toca BD. Los snapshots que se
// persisten guardan este desglose íntegro (defender una decisión de crédito
// meses después exige ver qué se sabía ese día).
// ─────────────────────────────────────────────────────────────────────────────

export interface DeclaracionMensualInsumo {
  /** "2026-03" */
  periodo: string;
  /** Ingresos declarados del mes (base RESICO / ingresos nominales). */
  ingresos: number | null;
  /** ISR + IVA + IEPS pagados (evidencia de actividad real). */
  impuestosPagados: number;
  /** Fecha de presentación (ISO) — null si no consta. */
  fechaPresentacion: string | null;
}

export interface InsumosCredito {
  declaraciones: DeclaracionMensualInsumo[];
  /** Renglones que el checklist aún pide (acuses faltantes). */
  acusesFaltantes: number;
  /** Última opinión de cumplimiento del SAT, si la tenemos. */
  opinionSat: "POSITIVA" | "NEGATIVA" | null;
  /** ¿El RFC (o sus contrapartes frecuentes) aparece en 69-B? */
  efosAbiertos: number | null;
  /** Gastos facturados (CFDIs EGRESO vigentes) de los últimos 12 meses. */
  gastosFacturados12m: number;
  /** Gastos facturados por mes — alimenta la gráfica de la ficha. */
  gastosPorMes: Array<{ periodo: string; total: number }>;
  /** Nómina timbrada (CFDIs NOMINA) de los últimos 12 meses. */
  nomina12m: number;
  /** Flujos bancarios (estados de cuenta) — null si no hay movimientos. */
  bancos: {
    mesesConDatos: number;
    /** Promedio mensual de abonos (entradas). */
    abonosProm: number;
    /** Promedio mensual de cargos (salidas, positivo). */
    cargosProm: number;
    /** Serie mensual (habilita recencia, mes malo y la tabla de flujo).
     *  Opcional: snapshots/tests viejos no la traen. */
    porMes?: Array<{ periodo: string; abonos: number; cargos: number }>;
    /** Saldo del último movimiento con saldo de cada mes (colchón). */
    saldosFinMes?: Array<{ periodo: string; saldo: number }>;
  } | null;
  /**
   * Cartera PPD y comportamiento de pago, derivados de los REPs
   * (PagoDoctoRelacionado): cuánto tardan SUS CLIENTES en pagarle (cobranza)
   * y cuánto tarda ELLA en pagar a proveedores (lo más parecido a un historial
   * de buró que se puede calcular con datos fiscales). Null sin facturas PPD.
   */
  flujosPPD: {
    cobranza: {
      facturas: number;
      monto: number;
      cobrado: number;
      saldoInsoluto: number;
      /** Días promedio de cobro (fechaPago REP − fecha factura), ponderado por monto. */
      diasPromedio: number | null;
    };
    pagos: {
      facturas: number;
      monto: number;
      pagado: number;
      /** Días promedio en que paga a sus proveedores. */
      diasPromedio: number | null;
    };
  } | null;
  /** Métricas de CFDIs de los últimos 12 meses — null si aún no hay descarga. */
  cfdis: {
    ingresosFacturados: number;
    /** Facturado por mes ("2026-03" → total) para comparar SOLO meses donde
     *  también hay declaración — un backfill a medias no debe fingir
     *  subfacturación. */
    facturadoPorMes: Array<{ periodo: string; total: number }>;
    emitidosVigentes: number;
    emitidosCancelados: number;
    /** % de la facturación concentrada en el cliente top (0-100). */
    topClientePct: number | null;
    clientesActivos: number;
  } | null;
}

export interface DimensionScore {
  clave: string;
  etiqueta: string;
  /** Peso nominal (los excluidos se redistribuyen). */
  peso: number;
  /** 0-100 dentro de la dimensión. */
  puntos: number;
  razones: string[];
}

export interface ResultadoScore {
  score: number; // 0-100
  banda: "A" | "B" | "C" | "D";
  /** Sugerencia inicial de línea: múltiplo del ingreso mensual promedio según banda. */
  limiteSugerido: number;
  provisional: boolean;
  dimensiones: DimensionScore[];
  /** Insumos ausentes que dejaron el score parcial. */
  cobertura: string[];
  /** Flujo libre estimado por mes (null si no hay datos de gasto). Insumo del simulador de préstamo. */
  flujoLibreMensual: number | null;
  /** Pago mensual máximo recomendado (fracción del flujo libre según banda). */
  pagoMensualMax: number | null;
  /** Desglose del cálculo del pago máximo — cada variable, para la ficha. */
  capacidadDesglose: {
    ingresosProm: number;
    gastosProm: number;
    nominaProm: number;
    impuestosProm: number;
    flujoLibre: number;
    /** Razón de servicio de deuda aplicada según la banda (0.4/0.3/0.2/0). */
    theta: number;
    /** Neto bancario mensual real (abonos − cargos), cuando hay ≥3 meses de
     *  estados de cuenta. Null/ausente sin datos bancarios (snapshots viejos). */
    flujoBancarioNeto?: number | null;
    /** Qué estimación determinó el flujo libre:
     *  - "fiscal": ingresos declarados − gastos facturados − nómina − impuestos.
     *  - "bancario": el neto bancario real fue MENOR que la estimación fiscal y
     *    la acota (prudencia: se presta contra el flujo que sí se ve en banco).
     *  - "solo_bancario": sin CFDIs; ingresosProm/gastosProm son entradas y
     *    salidas del banco (expediente delgado). */
    fuenteFlujo?: "fiscal" | "bancario" | "solo_bancario";
    /** Efectivo declarado no depositado reconocido al 50% (solo con patrón
     *  público-en-general verificado). Suma al neto bancario en la cota. */
    efectivoReconocido?: number | null;
    /** p25 del flujo mensual bancario ajustado — lo que puede pagar en un MES
     *  MALO. El pago máximo sale del menor entre esto y el flujo libre. */
    flujoMesMalo?: number | null;
    /** Saldo promedio de fin de mes (colchón) — null sin saldos. */
    saldoPromedio?: number | null;
  } | null;
}

const r0 = (n: number) => Math.round(n);

/**
 * Convierte ingresos declarados ACUMULADOS del ejercicio en ingresos DEL MES:
 * cada mes vale su acumulado menos el acumulado anterior del MISMO ejercicio
 * (enero, o el primer mes con dato, vale su acumulado tal cual). Un delta
 * negativo (complementaria que corrigió a la baja, dato chueco) queda en null
 * en vez de inventar un mes negativo.
 *
 * Se aplica ANTES del score cuando el régimen declara acumulado (PM Art. 14,
 * PF 612 Art. 106 — ver pagosProvisionalesAcumulan). Sin esto, una PM parecía
 * ingresar ~$950k/mes cuando su ingreso real era el delta (~$60-80k).
 */
export function desacumularIngresosDeclarados(
  declaraciones: DeclaracionMensualInsumo[],
): DeclaracionMensualInsumo[] {
  const orden = [...declaraciones].sort((a, b) => a.periodo.localeCompare(b.periodo));
  const previoPorEjercicio = new Map<string, number>();
  const porPeriodo = new Map<string, number | null>();
  for (const d of orden) {
    if (d.ingresos == null) continue;
    const ejercicio = d.periodo.slice(0, 4);
    const previo = previoPorEjercicio.get(ejercicio);
    const mensual = previo == null ? d.ingresos : d.ingresos - previo;
    porPeriodo.set(d.periodo, mensual >= 0 ? mensual : null);
    previoPorEjercicio.set(ejercicio, d.ingresos);
  }
  return declaraciones.map((d) =>
    d.ingresos == null ? d : { ...d, ingresos: porPeriodo.get(d.periodo) ?? null },
  );
}
const pct = (n: number) => `${Math.round(n * 100)}%`;
const money = (n: number) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(n);

/** Día límite legal de la mensual: 17 del mes siguiente + tolerancia por los
 *  días adicionales por sexto dígito del RFC (hasta +5) y prórrogas de portal. */
const TOLERANCIA_DIAS = 8;

function fechaLimiteConTolerancia(periodo: string): Date | null {
  const [y, m] = periodo.split("-").map(Number);
  if (!y || !m) return null;
  return new Date(Date.UTC(y, m, 17 + TOLERANCIA_DIAS, 23, 59, 59));
}

/** Meses transcurridos entre dos periodos "YYYY-MM" (a − b). */
function mesesEntre(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (ay - by) * 12 + (am - bm);
}

/** Vida media de la ponderación por recencia: el mes de hace 6 meses pesa la
 *  mitad que el mes más reciente. El buen pagador se predice con lo que el
 *  negocio hace HOY, no con el promedio plano del año. */
export const VIDA_MEDIA_MESES = 6;

/**
 * Promedio ponderado por recencia sobre una serie mensual: peso 0.5^(edad/6)
 * respecto al periodo más reciente de la serie. Null con serie vacía. PURA.
 */
export function promedioPonderadoPorRecencia(
  serie: Array<{ periodo: string; valor: number }>,
): number | null {
  if (serie.length === 0) return null;
  const ref = serie.reduce((m, s) => (s.periodo > m ? s.periodo : m), serie[0].periodo);
  let suma = 0;
  let pesos = 0;
  for (const s of serie) {
    const edad = Math.max(0, mesesEntre(ref, s.periodo));
    const w = Math.pow(0.5, edad / VIDA_MEDIA_MESES);
    suma += s.valor * w;
    pesos += w;
  }
  return pesos > 0 ? suma / pesos : null;
}

/** Percentil (interpolación lineal) — p en [0,1]. Null con lista vacía. */
export function percentil(vals: number[], p: number): number | null {
  if (vals.length === 0) return null;
  const orden = [...vals].sort((a, b) => a - b);
  const idx = (orden.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return orden[lo];
  return orden[lo] + (orden[hi] - orden[lo]) * (idx - lo);
}

/** Pendiente relativa: compara promedio de la mitad reciente vs la anterior. */
function tendencia(ingresos: number[]): number {
  if (ingresos.length < 4) return 0;
  const mitad = Math.floor(ingresos.length / 2);
  const antes = ingresos.slice(0, mitad);
  const despues = ingresos.slice(mitad);
  const pa = antes.reduce((s, v) => s + v, 0) / antes.length;
  const pd = despues.reduce((s, v) => s + v, 0) / despues.length;
  if (pa <= 0) return 0;
  return (pd - pa) / pa;
}

function coefVariacion(vals: number[]): number {
  if (vals.length < 2) return 0;
  const media = vals.reduce((s, v) => s + v, 0) / vals.length;
  if (media <= 0) return 0;
  const varianza = vals.reduce((s, v) => s + (v - media) ** 2, 0) / vals.length;
  return Math.sqrt(varianza) / media;
}

export function calcularScoreCredito(insumos: InsumosCredito): ResultadoScore {
  const dims: DimensionScore[] = [];
  const cobertura: string[] = [];

  const conIngresos = insumos.declaraciones.filter((d) => d.ingresos != null && d.ingresos > 0);
  const ingresos = conIngresos
    .slice()
    .sort((a, b) => a.periodo.localeCompare(b.periodo))
    .map((d) => d.ingresos as number);
  const promedioMensual = ingresos.length > 0 ? ingresos.reduce((s, v) => s + v, 0) / ingresos.length : 0;

  // ── 1. Actividad declarada (30) ────────────────────────────────────────────
  if (ingresos.length >= 3) {
    const razones: string[] = [];
    let puntos = 0;

    // Nivel: escala log-ish por bandas de ingreso mensual promedio.
    const nivel =
      promedioMensual >= 500_000 ? 40 :
      promedioMensual >= 200_000 ? 35 :
      promedioMensual >= 80_000 ? 28 :
      promedioMensual >= 30_000 ? 20 : 10;
    puntos += nivel;
    razones.push(`Ingreso declarado promedio ${money(promedioMensual)}/mes sobre ${ingresos.length} meses.`);

    // Tendencia: creciendo suma, cayendo resta.
    const t = tendencia(ingresos);
    const ptsTendencia = t >= 0.15 ? 30 : t >= 0 ? 22 : t >= -0.2 ? 12 : 0;
    puntos += ptsTendencia;
    razones.push(
      t >= 0.15 ? `Tendencia creciente (${pct(t)} reciente vs anterior).` :
      t >= 0 ? "Ingresos estables." :
      t >= -0.2 ? `Ligera caída reciente (${pct(t)}).` : `Caída fuerte reciente (${pct(t)}).`,
    );

    // Volatilidad: CV bajo = flujo predecible.
    const cv = coefVariacion(ingresos);
    const ptsVol = cv <= 0.25 ? 30 : cv <= 0.5 ? 22 : cv <= 0.8 ? 12 : 5;
    puntos += ptsVol;
    razones.push(cv <= 0.25 ? "Baja volatilidad mensual." : cv <= 0.5 ? "Volatilidad moderada." : "Ingresos muy variables mes a mes.");

    dims.push({ clave: "actividad", etiqueta: "Actividad declarada", peso: 20, puntos: Math.min(100, puntos), razones });
  } else {
    cobertura.push("Menos de 3 meses de declaraciones con ingresos — sin base para medir actividad.");
  }

  // ── 2. Cumplimiento fiscal (25) ────────────────────────────────────────────
  {
    const razones: string[] = [];
    let puntos = 0;

    const conFecha = insumos.declaraciones.filter((d) => d.fechaPresentacion);
    if (conFecha.length > 0) {
      const puntuales = conFecha.filter((d) => {
        const limite = fechaLimiteConTolerancia(d.periodo);
        return limite != null && new Date(d.fechaPresentacion as string).getTime() <= limite.getTime();
      }).length;
      const tasa = puntuales / conFecha.length;
      puntos += tasa >= 0.95 ? 40 : tasa >= 0.8 ? 30 : tasa >= 0.5 ? 15 : 5;
      razones.push(`${puntuales}/${conFecha.length} declaraciones presentadas dentro del plazo (con tolerancia de ${TOLERANCIA_DIAS} días).`);
    } else {
      razones.push("Sin fechas de presentación capturadas — puntualidad no medible.");
      cobertura.push("Fechas de presentación ausentes en las declaraciones.");
      puntos += 20; // neutro: ni premio ni castigo
    }

    // Completitud del expediente.
    puntos += insumos.acusesFaltantes === 0 ? 30 : insumos.acusesFaltantes <= 3 ? 20 : insumos.acusesFaltantes <= 8 ? 10 : 0;
    razones.push(
      insumos.acusesFaltantes === 0
        ? "Expediente de declaraciones completo."
        : `${insumos.acusesFaltantes} acuse(s) pendientes de capturar.`,
    );

    // Opinión del SAT.
    if (insumos.opinionSat === "POSITIVA") {
      puntos += 30;
      razones.push("Opinión de cumplimiento del SAT: POSITIVA.");
    } else if (insumos.opinionSat === "NEGATIVA") {
      razones.push("Opinión de cumplimiento del SAT: NEGATIVA.");
    } else {
      puntos += 15; // desconocida: neutro
      razones.push("Opinión del SAT no disponible (requiere plan con Syntage).");
      cobertura.push("Opinión de cumplimiento del SAT no disponible.");
    }

    dims.push({ clave: "cumplimiento", etiqueta: "Cumplimiento fiscal", peso: 20, puntos: Math.min(100, puntos), razones });
  }

  // ── 3. Consistencia CFDI vs declarado (20) ─────────────────────────────────
  if (insumos.cfdis && promedioMensual > 0) {
    const razones: string[] = [];
    let puntos = 0;
    const c = insumos.cfdis;

    // Comparar SOLO los meses con ambos lados presentes: CFDIs y declaración.
    // Un backfill a medias comparado contra todo lo declarado fingiría
    // subfacturación (caso real: razón 0.58 con la descarga recién arrancando).
    const declaradoPorMes = new Map(conIngresos.map((d) => [d.periodo, d.ingresos as number]));
    const solapados = c.facturadoPorMes.filter((f) => declaradoPorMes.has(f.periodo));
    const facturadoSolapado = solapados.reduce((s, f) => s + f.total, 0);
    const declaradoSolapado = solapados.reduce((s, f) => s + (declaradoPorMes.get(f.periodo) ?? 0), 0);

    if (solapados.length >= 3 && declaradoSolapado > 0) {
      const ratio = facturadoSolapado / declaradoSolapado;
      // ASIMÉTRICO a propósito: declarar MÁS de lo facturado es el patrón
      // honesto de quien vende a público en general (efectivo declarado sin
      // CFDI individual) — no se castiga. La señal de riesgo es la inversa:
      // facturar más de lo que se declara (ingresos escondidos al SAT).
      puntos += ratio <= 1.1 ? 60 : ratio <= 1.3 ? 35 : 5;
      razones.push(
        `Facturado ${money(facturadoSolapado)} vs declarado ${money(declaradoSolapado)} en ${solapados.length} mes(es) comparables (razón ${ratio.toFixed(2)}).`,
      );
      if (ratio <= 1.1 && ratio < 0.85) {
        razones.push("Declara más de lo que factura — patrón consistente con venta a público en general (sin señal de riesgo).");
      } else if (ratio > 1.3) {
        razones.push("Factura más de lo que declara — posible subdeclaración de ingresos.");
      }
    } else {
      razones.push("Menos de 3 meses con CFDIs y declaración a la vez — comparación aplazada.");
      puntos += 25;
    }

    const totalEmitidos = c.emitidosVigentes + c.emitidosCancelados;
    const tasaCancel = totalEmitidos > 0 ? c.emitidosCancelados / totalEmitidos : 0;
    puntos += tasaCancel <= 0.05 ? 40 : tasaCancel <= 0.15 ? 25 : 5;
    razones.push(`Tasa de cancelación de CFDIs: ${pct(tasaCancel)} (${c.emitidosCancelados}/${totalEmitidos}).`);

    dims.push({ clave: "consistencia", etiqueta: "Consistencia CFDI vs declarado", peso: 15, puntos: Math.min(100, puntos), razones });
  } else {
    cobertura.push("CFDIs no disponibles todavía — consistencia facturado/declarado sin evaluar.");
  }

  // ── 3b. Capacidad de pago (20): margen y flujo, no sólo ingreso ────────────
  // El límite no debe salir del ingreso bruto: una empresa que factura mucho y
  // gasta igual no tiene con qué pagar. Flujo libre estimado = ingresos
  // declarados − gastos facturados − nómina timbrada − impuestos pagados.
  // Los estados de cuenta, cuando hay ≥3 meses, dejan de ser sólo corroboración:
  // el neto bancario real ACOTA el flujo libre (min de ambas estimaciones) — la
  // estimación fiscal sobreestima cuando el cliente compra sin factura (típico
  // RESICO PF con 0 CFDIs de gasto), y no se presta contra flujo que el banco
  // no ve. Sin CFDIs, el banco solo alcanza para calificar capacidad.
  let flujoLibreMensual: number | null = null;
  let capacidadDesglose: ResultadoScore["capacidadDesglose"] = null;
  const bancosUsables = insumos.bancos && insumos.bancos.mesesConDatos >= 3 ? insumos.bancos : null;
  const netoBancario = bancosUsables ? bancosUsables.abonosProm - bancosUsables.cargosProm : null;
  if (insumos.cfdis && promedioMensual > 0) {
    const razones: string[] = [];
    let puntos = 0;

    // Todos los promedios de capacidad van PONDERADOS POR RECENCIA (vida media
    // 6 meses): el pago del crédito sale del flujo de los próximos meses, y el
    // mejor predictor es lo reciente, no el promedio plano del año.
    const mesesCoberturaSet = new Set([
      ...(insumos.cfdis?.facturadoPorMes ?? []).map((f) => f.periodo),
      ...insumos.gastosPorMes.map((g) => g.periodo),
    ]);
    const mesesCobertura = mesesCoberturaSet.size;
    // Gastos: serie mensual sobre la ventana de cobertura, con 0 en los meses
    // cubiertos sin CFDIs de gasto (ese mes realmente no facturó compras).
    // Sin serie mensual (insumos viejos que sólo traen el agregado 12m) se
    // promedia el agregado sobre la cobertura — NUNCA se asume gasto cero.
    const divisor = Math.min(12, Math.max(1, mesesCobertura));
    const gastosPorPeriodo = new Map(insumos.gastosPorMes.map((g) => [g.periodo, g.total]));
    const serieGastos = [...mesesCoberturaSet].map((p) => ({ periodo: p, valor: gastosPorPeriodo.get(p) ?? 0 }));
    const gastosProm =
      insumos.gastosPorMes.length > 0
        ? promedioPonderadoPorRecencia(serieGastos) ?? 0
        : insumos.gastosFacturados12m / divisor;
    const nominaProm = insumos.nomina12m / divisor; // sólo hay agregado anual
    const ingresosPromRec =
      promedioPonderadoPorRecencia(
        conIngresos.map((d) => ({ periodo: d.periodo, valor: d.ingresos as number })),
      ) ?? promedioMensual;
    const impuestosProm =
      promedioPonderadoPorRecencia(
        insumos.declaraciones.map((d) => ({ periodo: d.periodo, valor: d.impuestosPagados })),
      ) ?? 0;
    const flujoFiscal = Math.max(0, ingresosPromRec - gastosProm - nominaProm - impuestosProm);

    // Neto bancario ponderado por recencia (con serie); sin serie, el simple.
    const serieNetoBanco = (bancosUsables?.porMes ?? []).map((m) => ({
      periodo: m.periodo,
      valor: m.abonos - m.cargos,
    }));
    const netoBancarioRec =
      serieNetoBanco.length > 0 ? promedioPonderadoPorRecencia(serieNetoBanco) : netoBancario;
    const abonosPromRec =
      promedioPonderadoPorRecencia(
        (bancosUsables?.porMes ?? []).map((m) => ({ periodo: m.periodo, valor: m.abonos })),
      ) ?? bancosUsables?.abonosProm ?? null;

    // Ajuste de EFECTIVO DECLARADO: cuando el patrón público-en-general está
    // verificado (declara consistentemente MÁS de lo que factura, y paga ISR
    // sobre ello — señal costosa de que ese ingreso es real), se reconoce el
    // 50% del ingreso declarado que no se ve en depósitos. Sin ese patrón, el
    // efectivo no depositado NO cuenta.
    let efectivoReconocido = 0;
    if (bancosUsables && abonosPromRec != null) {
      const declaradoPorMesCap = new Map(conIngresos.map((d) => [d.periodo, d.ingresos as number]));
      const solapadosCap = (insumos.cfdis?.facturadoPorMes ?? []).filter((f) => declaradoPorMesCap.has(f.periodo));
      const factCap = solapadosCap.reduce((s, f) => s + f.total, 0);
      const declCap = solapadosCap.reduce((s, f) => s + (declaradoPorMesCap.get(f.periodo) ?? 0), 0);
      const patronPublicoGeneral = solapadosCap.length >= 3 && declCap > 0 && factCap / declCap < 0.9;
      if (patronPublicoGeneral) {
        efectivoReconocido = 0.5 * Math.max(0, ingresosPromRec - abonosPromRec);
      }
    }
    const netoAjustado = netoBancarioRec != null ? netoBancarioRec + efectivoReconocido : null;

    let fuenteFlujo: "fiscal" | "bancario" = "fiscal";
    flujoLibreMensual = flujoFiscal;
    if (netoAjustado != null && netoAjustado < flujoFiscal) {
      flujoLibreMensual = Math.max(0, netoAjustado);
      fuenteFlujo = "bancario";
    }

    // MES MALO: p25 del neto bancario mensual ajustado — lo que puede pagar en
    // un mes flojo, no en el promedio. El pago máximo se acota con esto abajo.
    const flujoMesMalo =
      serieNetoBanco.length >= 4
        ? Math.max(0, (percentil(serieNetoBanco.map((s) => s.valor), 0.25) ?? 0) + efectivoReconocido)
        : null;

    // Colchón: saldo promedio de fin de mes vs salidas — cuántos días aguanta.
    const saldos = (bancosUsables?.saldosFinMes ?? []).map((s) => s.saldo);
    const saldoPromedio = saldos.length > 0 ? saldos.reduce((s, v) => s + v, 0) / saldos.length : null;

    capacidadDesglose = {
      ingresosProm: Math.round(ingresosPromRec),
      gastosProm: Math.round(gastosProm),
      nominaProm: Math.round(nominaProm),
      impuestosProm: Math.round(impuestosProm),
      flujoLibre: Math.round(flujoLibreMensual),
      theta: 0, // se fija abajo, cuando ya se conoce la banda
      flujoBancarioNeto: netoBancarioRec != null ? Math.round(netoBancarioRec) : null,
      fuenteFlujo,
      efectivoReconocido: efectivoReconocido > 0 ? Math.round(efectivoReconocido) : null,
      flujoMesMalo: flujoMesMalo != null ? Math.round(flujoMesMalo) : null,
      saldoPromedio: saldoPromedio != null ? Math.round(saldoPromedio) : null,
    };
    const margen = ingresosPromRec > 0 ? flujoLibreMensual / ingresosPromRec : 0;

    puntos += margen >= 0.35 ? 60 : margen >= 0.2 ? 45 : margen >= 0.1 ? 30 : margen > 0 ? 15 : 5;
    razones.push(
      `Flujo libre fiscal estimado ${money(flujoFiscal)}/mes, ponderado por recencia (ingresos ${money(ingresosPromRec)} − gastos facturados ${money(gastosProm)} − nómina ${money(nominaProm)} − impuestos ${money(impuestosProm)}).`,
    );
    if (fuenteFlujo === "bancario") {
      razones.push(
        `El neto bancario real (${money(netoBancarioRec!)}/mes${efectivoReconocido > 0 ? ` + ${money(efectivoReconocido)} de efectivo declarado reconocido al 50%` : ""}) es MENOR que la estimación fiscal — el flujo libre se acota al banco: ${money(flujoLibreMensual)}/mes (margen ${pct(margen)}).`,
      );
    } else {
      razones.push(`Margen de flujo libre: ${pct(margen)}.`);
      if (efectivoReconocido > 0 && netoAjustado != null) {
        razones.push(
          `Efectivo declarado no depositado reconocido al 50% (${money(efectivoReconocido)}/mes) — patrón público en general verificado.`,
        );
      }
    }
    if (flujoMesMalo != null) {
      razones.push(
        `Mes malo (p25 del neto bancario ajustado): ${money(flujoMesMalo)}/mes — el pago máximo se calcula sobre el menor entre esto y el flujo libre.`,
      );
    }
    if (saldoPromedio != null && bancosUsables) {
      const cargosRef = bancosUsables.cargosProm > 0 ? bancosUsables.cargosProm : null;
      const dias = cargosRef ? Math.round((saldoPromedio / cargosRef) * 30) : null;
      razones.push(
        `Colchón bancario: saldo promedio de fin de mes ${money(saldoPromedio)}${dias != null ? ` (~${dias} día(s) de operación sin un solo ingreso)` : ""}.`,
      );
    }
    if (insumos.gastosFacturados12m === 0) {
      razones.push(
        netoBancarioRec != null
          ? "Sin CFDIs de gasto registrados — los gastos reales se leen del banco."
          : "Sin CFDIs de gasto registrados — el margen puede estar sobreestimado (compras sin factura).",
      );
    }
    if (mesesCobertura > 0 && mesesCobertura < 6) {
      razones.push(
        `Cobertura de CFDIs parcial (${mesesCobertura} mes(es)) — gastos promediados sólo sobre esa ventana; la descarga histórica sigue en curso.`,
      );
    }

    if (bancosUsables && netoBancarioRec != null) {
      puntos += netoBancarioRec > 0 ? 40 : netoBancarioRec > -0.05 * bancosUsables.abonosProm ? 25 : 10;
      razones.push(
        `Flujo bancario real (${bancosUsables.mesesConDatos} meses, ponderado por recencia): entradas ${money(bancosUsables.abonosProm)}/mes vs salidas ${money(bancosUsables.cargosProm)}/mes — neto ${money(netoBancarioRec)}.`,
      );
    } else {
      puntos += 20; // neutro
      razones.push("Sin estados de cuenta cargados — flujo bancario no corroborado.");
      cobertura.push("Estados de cuenta bancarios no disponibles — capacidad de pago sin corroborar.");
    }

    dims.push({ clave: "capacidad", etiqueta: "Capacidad de pago", peso: 20, puntos: Math.max(0, Math.min(100, puntos)), razones });
  } else if (bancosUsables && netoBancario != null) {
    // Expediente delgado: sin CFDIs (o sin ingresos declarados), pero CON
    // estados de cuenta. El banco alcanza para calificar capacidad — entradas
    // como proxy de ingreso, salidas como gasto total (ya incluyen impuestos y
    // nómina, por eso no se restan aparte). Las transferencias internas vienen
    // excluidas desde el loader.
    const razones: string[] = [];
    const serieNetoBanco = (bancosUsables.porMes ?? []).map((m) => ({
      periodo: m.periodo,
      valor: m.abonos - m.cargos,
    }));
    const netoRec = serieNetoBanco.length > 0 ? promedioPonderadoPorRecencia(serieNetoBanco)! : netoBancario;
    flujoLibreMensual = Math.max(0, netoRec);
    const flujoMesMalo =
      serieNetoBanco.length >= 4
        ? Math.max(0, percentil(serieNetoBanco.map((s) => s.valor), 0.25) ?? 0)
        : null;
    const base = promedioMensual > 0 ? promedioMensual : bancosUsables.abonosProm;
    const margen = base > 0 ? flujoLibreMensual / base : 0;
    let puntos = margen >= 0.35 ? 60 : margen >= 0.2 ? 45 : margen >= 0.1 ? 30 : margen > 0 ? 15 : 5;
    puntos += netoRec > 0 ? 40 : netoRec > -0.05 * bancosUsables.abonosProm ? 25 : 10;
    razones.push(
      `Capacidad estimada SOLO con flujo bancario (${bancosUsables.mesesConDatos} meses, ponderado por recencia): entradas ${money(bancosUsables.abonosProm)}/mes − salidas ${money(bancosUsables.cargosProm)}/mes = neto ${money(netoRec)} (margen ${pct(margen)}).`,
    );
    if (flujoMesMalo != null) {
      razones.push(`Mes malo (p25 del neto bancario): ${money(flujoMesMalo)}/mes.`);
    }
    const saldos = (bancosUsables.saldosFinMes ?? []).map((s) => s.saldo);
    const saldoPromedio = saldos.length > 0 ? saldos.reduce((s, v) => s + v, 0) / saldos.length : null;
    capacidadDesglose = {
      ingresosProm: Math.round(bancosUsables.abonosProm),
      gastosProm: Math.round(bancosUsables.cargosProm),
      nominaProm: 0,
      impuestosProm: 0,
      flujoLibre: Math.round(flujoLibreMensual),
      theta: 0,
      flujoBancarioNeto: Math.round(netoRec),
      fuenteFlujo: "solo_bancario",
      flujoMesMalo: flujoMesMalo != null ? Math.round(flujoMesMalo) : null,
      saldoPromedio: saldoPromedio != null ? Math.round(saldoPromedio) : null,
    };
    dims.push({ clave: "capacidad", etiqueta: "Capacidad de pago", peso: 20, puntos: Math.max(0, Math.min(100, puntos)), razones });
    cobertura.push("CFDIs no disponibles — capacidad estimada únicamente con estados de cuenta.");
  } else if (promedioMensual > 0) {
    cobertura.push("Capacidad de pago sin evaluar (requiere CFDIs o ≥3 meses de estados de cuenta).");
  }

  // ── 4. Estabilidad de clientes (15) ────────────────────────────────────────
  if (insumos.cfdis && insumos.cfdis.clientesActivos > 0) {
    const razones: string[] = [];
    let puntos = 0;
    const c = insumos.cfdis;

    if (c.topClientePct != null) {
      puntos += c.topClientePct <= 30 ? 60 : c.topClientePct <= 50 ? 45 : c.topClientePct <= 70 ? 25 : 10;
      razones.push(`Cliente principal concentra ${Math.round(c.topClientePct)}% de la facturación.`);
    } else {
      puntos += 30;
      razones.push("Concentración por cliente no calculable.");
    }
    puntos += c.clientesActivos >= 20 ? 40 : c.clientesActivos >= 8 ? 30 : c.clientesActivos >= 3 ? 18 : 8;
    razones.push(`${c.clientesActivos} cliente(s) activos en 12 meses.`);

    // Cobranza PPD (de los REPs): ¿sus clientes le pagan, y qué tan rápido?
    // Una cartera con mucho saldo insoluto o cobro lento es riesgo directo
    // sobre el flujo con el que pagaría el crédito.
    const cob = insumos.flujosPPD?.cobranza;
    if (cob && cob.monto > 0) {
      const pctInsoluto = cob.saldoInsoluto / cob.monto;
      razones.push(
        `Cartera PPD 12m: ${cob.facturas} factura(s) por ${money(cob.monto)} — cobrado ${money(cob.cobrado)} (${pct(cob.cobrado / cob.monto)}), saldo insoluto ${money(cob.saldoInsoluto)}${cob.diasPromedio != null ? `, cobro promedio ${Math.round(cob.diasPromedio)} días` : ""}.`,
      );
      if (pctInsoluto > 0.5) {
        puntos -= 20;
        razones.push("Más de la mitad de la cartera PPD sigue sin cobrar — riesgo de cobranza.");
      }
      if (cob.diasPromedio != null && cob.diasPromedio > 90) {
        puntos -= 10;
        razones.push("Cobro promedio mayor a 90 días — ciclo de conversión lento.");
      }
    }

    dims.push({ clave: "clientes", etiqueta: "Estabilidad de clientes", peso: 10, puntos: Math.max(0, Math.min(100, puntos)), razones });
  } else {
    cobertura.push("Cartera de clientes no disponible (requiere CFDIs).");
  }

  // ── 4b. Comportamiento de pago (10) ────────────────────────────────────────
  // La señal que MEJOR predice al buen pagador no es cuánto gana sino cómo ha
  // cumplido obligaciones recurrentes: a qué plazo paga a sus proveedores, qué
  // proporción de lo que debe liquida, y si cumple mes a mes con el SAT (una
  // obligación con fecha fija y consecuencia real). Es lo más parecido a un
  // historial de buró calculable sin buró. Se excluye si no hay ninguna señal.
  {
    const razones: string[] = [];
    let puntos = 0;
    let señales = 0;

    const pp = insumos.flujosPPD?.pagos;
    if (pp && pp.monto > 0 && pp.diasPromedio != null) {
      señales++;
      const d = pp.diasPromedio;
      puntos += d <= 30 ? 40 : d <= 60 ? 32 : d <= 90 ? 22 : d <= 120 ? 12 : 0;
      const liquidado = pp.pagado / pp.monto;
      puntos += liquidado >= 0.9 ? 30 : liquidado >= 0.7 ? 22 : liquidado >= 0.5 ? 12 : 5;
      razones.push(
        `Paga a sus proveedores en ~${Math.round(d)} días (${pp.facturas} factura(s) PPD por ${money(pp.monto)}, liquidado ${pct(liquidado)}).`,
      );
      if (d > 120) razones.push("Paga a más de 120 días — señal de estrés de flujo o mala disciplina de pago.");
    }

    // Puntualidad RECIENTE (últimos 12 periodos declarados): cumplir con el SAT
    // mes a mes es la obligación recurrente que ya observamos.
    const recientes = insumos.declaraciones
      .filter((d) => d.fechaPresentacion)
      .sort((a, b) => b.periodo.localeCompare(a.periodo))
      .slice(0, 12);
    if (recientes.length >= 3) {
      señales++;
      const puntuales = recientes.filter((d) => {
        const limite = fechaLimiteConTolerancia(d.periodo);
        return limite != null && new Date(d.fechaPresentacion as string).getTime() <= limite.getTime();
      }).length;
      const tasa = puntuales / recientes.length;
      puntos += tasa >= 0.95 ? 30 : tasa >= 0.8 ? 22 : tasa >= 0.5 ? 10 : 0;
      razones.push(
        `Puntualidad reciente: ${puntuales}/${recientes.length} de las últimas declaraciones dentro del plazo.`,
      );
    }

    // Estrés observable: meses con banco en rojo dentro de la ventana.
    const serieNeto = (insumos.bancos?.porMes ?? []).map((m) => m.abonos - m.cargos);
    if (serieNeto.length >= 4) {
      const negativos = serieNeto.filter((v) => v < 0).length;
      if (negativos / serieNeto.length > 0.5) {
        puntos -= 15;
        razones.push(
          `${negativos} de ${serieNeto.length} meses cerraron con salidas mayores que entradas — estrés de flujo recurrente.`,
        );
      }
    }

    if (señales > 0) {
      dims.push({
        clave: "comportamiento",
        etiqueta: "Comportamiento de pago",
        peso: 10,
        puntos: Math.max(0, Math.min(100, puntos)),
        razones,
      });
    } else {
      cobertura.push("Sin historial de pagos observable (ni REPs de proveedores ni fechas de presentación).");
    }
  }

  // ── 5. Señales duras (10): EFOS ────────────────────────────────────────────
  {
    const razones: string[] = [];
    let puntos: number;
    if (insumos.efosAbiertos == null) {
      puntos = 50;
      razones.push("Cruce 69-B no disponible.");
      cobertura.push("Cruce EFOS (69-B) no disponible.");
    } else if (insumos.efosAbiertos === 0) {
      puntos = 100;
      razones.push("Sin hallazgos EFOS (69-B) abiertos.");
    } else {
      puntos = 0;
      razones.push(`${insumos.efosAbiertos} hallazgo(s) EFOS abiertos — riesgo directo de deducciones/operaciones simuladas.`);
    }
    // Peso bajo a propósito: un EFOS abierto ya impone techo duro de banda D
    // más abajo, así que su fuerza no depende del promedio ponderado.
    dims.push({ clave: "efos", etiqueta: "Señales duras (69-B)", peso: 5, puntos, razones });
  }

  // ── Agregación: redistribuir pesos de dimensiones ausentes ────────────────
  const pesoPresente = dims.reduce((s, d) => s + d.peso, 0);
  const score =
    pesoPresente > 0
      ? r0(dims.reduce((s, d) => s + (d.puntos * d.peso) / pesoPresente, 0))
      : 0;

  // EFOS abierto: techo duro en banda D — ningún promedio lo diluye.
  const efosListado = (insumos.efosAbiertos ?? 0) > 0;
  const banda: ResultadoScore["banda"] =
    efosListado ? "D" : score >= 80 ? "A" : score >= 65 ? "B" : score >= 50 ? "C" : "D";

  const multiplo = banda === "A" ? 1.0 : banda === "B" ? 0.6 : banda === "C" ? 0.3 : 0;

  // Base de capacidad: el flujo del MES MALO (p25 de la serie bancaria) cuando
  // se conoce, acotado por el flujo libre. Un crédito se paga TODOS los meses,
  // incluidos los flojos — dimensionarlo sobre el promedio es la causa clásica
  // de la primera mora. Sin serie bancaria, cae al flujo libre promedio.
  const mesMalo = capacidadDesglose?.flujoMesMalo ?? null;
  const baseCapacidad =
    flujoLibreMensual == null
      ? null
      : mesMalo != null
        ? Math.min(flujoLibreMensual, mesMalo)
        : flujoLibreMensual;

  // Límite anclado a CAPACIDAD DE PAGO cuando es estimable: ~3 meses de esa
  // base (con techo de 1.5× el ingreso mensual — el flujo no compra ingreso
  // que no existe). Sin datos de gasto, cae al múltiplo del ingreso (y la
  // cobertura ya lo marca como provisional).
  const base =
    baseCapacidad != null
      ? Math.min(baseCapacidad * 3, promedioMensual * 1.5)
      : promedioMensual;
  const limiteSugerido = Math.round((base * multiplo) / 1000) * 1000;

  // Pago mensual máximo: razón de servicio de deuda por banda sobre esa base.
  const theta = banda === "A" ? 0.4 : banda === "B" ? 0.3 : banda === "C" ? 0.2 : 0;
  const pagoMensualMax = baseCapacidad != null ? Math.round(baseCapacidad * theta) : null;
  if (capacidadDesglose) capacidadDesglose.theta = theta;

  return {
    score,
    banda,
    limiteSugerido,
    provisional: cobertura.length > 0,
    dimensiones: dims,
    cobertura,
    flujoLibreMensual: flujoLibreMensual != null ? Math.round(flujoLibreMensual) : null,
    pagoMensualMax,
    capacidadDesglose,
  };
}
