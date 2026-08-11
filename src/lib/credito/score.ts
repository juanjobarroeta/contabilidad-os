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
  /** Nómina timbrada (CFDIs NOMINA) de los últimos 12 meses. */
  nomina12m: number;
  /** Flujos bancarios (estados de cuenta) — null si no hay movimientos. */
  bancos: {
    mesesConDatos: number;
    /** Promedio mensual de abonos (entradas). */
    abonosProm: number;
    /** Promedio mensual de cargos (salidas, positivo). */
    cargosProm: number;
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
}

const r0 = (n: number) => Math.round(n);
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

    dims.push({ clave: "actividad", etiqueta: "Actividad declarada", peso: 25, puntos: Math.min(100, puntos), razones });
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
  // Los estados de cuenta (si hay) corroboran con el flujo bancario real.
  let flujoLibreMensual: number | null = null;
  if (insumos.cfdis && promedioMensual > 0) {
    const razones: string[] = [];
    let puntos = 0;

    const gastosProm = insumos.gastosFacturados12m / 12;
    const nominaProm = insumos.nomina12m / 12;
    const impuestosProm =
      insumos.declaraciones.length > 0
        ? insumos.declaraciones.reduce((s, d) => s + d.impuestosPagados, 0) / insumos.declaraciones.length
        : 0;
    flujoLibreMensual = Math.max(0, promedioMensual - gastosProm - nominaProm - impuestosProm);
    const margen = flujoLibreMensual / promedioMensual;

    puntos += margen >= 0.35 ? 60 : margen >= 0.2 ? 45 : margen >= 0.1 ? 30 : margen > 0 ? 15 : 5;
    razones.push(
      `Flujo libre estimado ${money(flujoLibreMensual)}/mes (ingresos ${money(promedioMensual)} − gastos facturados ${money(gastosProm)} − nómina ${money(nominaProm)} − impuestos ${money(impuestosProm)}): margen ${pct(margen)}.`,
    );
    if (insumos.gastosFacturados12m === 0) {
      razones.push("Sin CFDIs de gasto registrados — el margen puede estar sobreestimado (compras sin factura).");
    }

    if (insumos.bancos && insumos.bancos.mesesConDatos >= 3) {
      const neto = insumos.bancos.abonosProm - insumos.bancos.cargosProm;
      puntos += neto > 0 ? 40 : neto > -0.05 * insumos.bancos.abonosProm ? 25 : 10;
      razones.push(
        `Flujo bancario real (${insumos.bancos.mesesConDatos} meses): entradas ${money(insumos.bancos.abonosProm)}/mes vs salidas ${money(insumos.bancos.cargosProm)}/mes — neto ${money(neto)}.`,
      );
    } else {
      puntos += 20; // neutro
      razones.push("Sin estados de cuenta cargados — flujo bancario no corroborado.");
      cobertura.push("Estados de cuenta bancarios no disponibles — capacidad de pago sin corroborar.");
    }

    dims.push({ clave: "capacidad", etiqueta: "Capacidad de pago", peso: 20, puntos: Math.min(100, puntos), razones });
  } else if (promedioMensual > 0) {
    cobertura.push("Capacidad de pago sin evaluar (requiere CFDIs para estimar gastos).");
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

    dims.push({ clave: "clientes", etiqueta: "Estabilidad de clientes", peso: 10, puntos: Math.min(100, puntos), razones });
  } else {
    cobertura.push("Cartera de clientes no disponible (requiere CFDIs).");
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
    dims.push({ clave: "efos", etiqueta: "Señales duras (69-B)", peso: 10, puntos, razones });
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
  // Límite anclado a CAPACIDAD DE PAGO cuando es estimable: ~3 meses de flujo
  // libre (con techo de 1.5× el ingreso mensual — el flujo no compra ingreso
  // que no existe). Sin datos de gasto, cae al múltiplo del ingreso (y la
  // cobertura ya lo marca como provisional).
  const base =
    flujoLibreMensual != null
      ? Math.min(flujoLibreMensual * 3, promedioMensual * 1.5)
      : promedioMensual;
  const limiteSugerido = Math.round((base * multiplo) / 1000) * 1000;

  return {
    score,
    banda,
    limiteSugerido,
    provisional: cobertura.length > 0,
    dimensiones: dims,
    cobertura,
  };
}
