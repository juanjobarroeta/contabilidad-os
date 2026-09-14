// ─────────────────────────────────────────────────────────────────────────────
// Lo que consume un asiento del copiloto jurídico, y su tope.
//
// El copiloto contable tiene su guardia (`asegurarUsoIA`), pero mide por
// empresa y el jurídico no tiene empresa: el abogado caía en el cubo
// «gasto sin empresa» de 2 USD al mes, así que el jurídico corría SIN tope.
// Con un turno largo costando dólares, un asiento podía gastar más de lo que
// paga sin que nadie lo viera.
//
// Aquí: el gasto del mes por usuario (categorías LLM y OPENAI, subtipos
// `ai.juridico*`), desglosado por función, y un tope propio del asiento.
// El tope es generoso a propósito —es una herramienta de trabajo, no un
// juguete— y lo que hace es avisar y frenar el abuso, no racionar el día.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "@/lib/prisma";
import { reportError } from "@/lib/observability";

/** Tope mensual por asiento, en USD. `JURIDICO_USD_MENSUAL` lo sube o lo baja. */
export const TOPE_MENSUAL_USD = Number(process.env.JURIDICO_USD_MENSUAL ?? "60") || 60;
/** A partir de aquí la UI avisa (fracción del tope). */
export const UMBRAL_AVISO = 0.8;

export interface Consumo {
  /** Mes en curso, en hora de México (el corte que entiende el despacho). */
  periodo: string;
  usd: number;
  topeUsd: number;
  fraccion: number;
  avisar: boolean;
  excedido: boolean;
  /** Qué parte del gasto se fue en cada cosa. */
  porFuncion: { funcion: string; usd: number; operaciones: number }[];
  operaciones: number;
}

const NOMBRES: Record<string, string> = {
  "ai.juridico": "Consultas del chat",
  "ai.juridico.verificacion": "Verificación de citas",
  "ai.juridico.extraccion": "Datos de documentos",
  "ai.juridico.vision": "Transcripción de escaneos",
  "ai.juridico.ocr": "Transcripción de escaneos",
  "ai.juridico.resumen": "Resúmenes de expediente",
  "ai.juridico.redaccion": "Redacción por secciones",
  "ai.juridico.revision": "Relectura antes de entregar",
};

/** Primer instante del mes en curso, con el huso de México. */
export function inicioDeMes(ahora: Date = new Date()): Date {
  const mx = new Date(ahora.toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
  return new Date(Date.UTC(mx.getFullYear(), mx.getMonth(), 1, 6, 0, 0));
}

export function periodoDe(ahora: Date = new Date()): string {
  const mx = new Date(ahora.toLocaleString("en-US", { timeZone: "America/Mexico_City" }));
  return `${mx.getFullYear()}-${String(mx.getMonth() + 1).padStart(2, "0")}`;
}

/** Decide sobre cifras ya sumadas. Puro: es lo que se prueba. */
export function evaluarConsumo(usd: number, operaciones: number, porFuncion: { funcion: string; usd: number; operaciones: number }[], ahora: Date = new Date(), topeUsd: number = TOPE_MENSUAL_USD): Consumo {
  const fraccion = topeUsd > 0 ? usd / topeUsd : 0;
  return {
    periodo: periodoDe(ahora),
    usd: Math.round(usd * 100) / 100,
    topeUsd,
    fraccion: Math.round(fraccion * 100) / 100,
    avisar: fraccion >= UMBRAL_AVISO && fraccion < 1,
    excedido: fraccion >= 1,
    // Dos subtipos pueden compartir nombre (ocr y vision son «transcripción»):
    // se suman en un solo renglón, que es como lo lee el abogado.
    porFuncion: [...porFuncion.reduce((m, f) => {
      const nombre = NOMBRES[f.funcion] ?? f.funcion;
      const previo = m.get(nombre) ?? { funcion: nombre, usd: 0, operaciones: 0 };
      m.set(nombre, { funcion: nombre, usd: previo.usd + f.usd, operaciones: previo.operaciones + f.operaciones });
      return m;
    }, new Map<string, { funcion: string; usd: number; operaciones: number }>()).values()]
      .map((f) => ({ ...f, usd: Math.round(f.usd * 100) / 100 }))
      .sort((a, b) => b.usd - a.usd),
    operaciones,
  };
}

export async function consumoDelMes(userId: string, ahora: Date = new Date()): Promise<Consumo> {
  const filas = await prisma.costEvent.groupBy({
    by: ["subtipo"],
    where: { userId, occurredAt: { gte: inicioDeMes(ahora) }, subtipo: { startsWith: "ai.juridico" } },
    _sum: { costoMicroUsd: true },
    _count: { _all: true },
  });
  const porFuncion = filas.map((f) => ({ funcion: f.subtipo, usd: (f._sum.costoMicroUsd ?? 0) / 1e6, operaciones: f._count._all }));
  const usd = porFuncion.reduce((s, f) => s + f.usd, 0);
  const operaciones = porFuncion.reduce((s, f) => s + f.operaciones, 0);
  return evaluarConsumo(usd, operaciones, porFuncion, ahora);
}

export interface DecisionConsumo {
  permitido: boolean;
  motivo?: string;
  consumo?: Consumo;
}

/**
 * ¿Puede este asiento seguir trabajando? Nunca lanza: si la base falla,
 * deja pasar (preferimos cobrar de más una vez a dejar a un abogado parado
 * por un problema nuestro).
 */
export async function asegurarConsumoJuridico(userId: string): Promise<DecisionConsumo> {
  try {
    const consumo = await consumoDelMes(userId);
    if (!consumo.excedido) return { permitido: true, consumo };
    return {
      permitido: false,
      consumo,
      motivo: `Este asiento llegó a su tope de uso del mes (${consumo.usd.toFixed(2)} de ${consumo.topeUsd} USD). Pide que lo amplíen o espera al corte del mes; tus casos y borradores siguen ahí.`,
    };
  } catch (e) {
    reportError(e, { ruta: "juridico/consumo", userId });
    return { permitido: true };
  }
}
