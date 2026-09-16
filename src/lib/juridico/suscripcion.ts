// ─────────────────────────────────────────────────────────────────────────────
// Qué paga un despacho, y qué puede hacer antes de pagar.
//
// Se cobra POR ASIENTO, con la consulta incluida y un número de documentos de
// fondo al mes. La unidad es el DOCUMENTO, no los tokens ni «créditos»: es lo
// que un abogado ya sabe cotizar (cobra miles de pesos por un contrato), y
// además es lo que de verdad cuesta —una consulta sale en centavos, redactar
// un contrato son diecinueve generaciones—.
//
// Por qué no vendemos créditos de consulta: el valor del producto es que el
// abogado PREGUNTE antes de actuar. Ponerle contador a la pregunta hace que
// dude, y la duda mata el hábito que sostiene la renovación.
//
// La prueba: siete días, cinco documentos y un TOPE DE GASTO. Alcanza para
// llevar un asunto real de principio a fin, que es lo que se está comprando,
// sin que una cuenta de prueba nos cueste más de lo que jamás va a pagar —una
// semana de consultas sin freno son miles de pesos de API—.
//
// Con tarjeta desde el principio. No es un obstáculo: es lo que convierte la
// prueba en suscripción sola al séptimo día, en vez de pedirle al abogado que
// vuelva a decidir cuando ya se le pasó el entusiasmo.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "@/lib/prisma";
import { reportError } from "@/lib/observability";

export type PlanDespacho = "prueba" | "activo" | "suspendido" | "cancelado";

export const DIAS_DE_PRUEBA = 7;
export const DOCUMENTOS_DE_PRUEBA = 5;
/**
 * Lo que puede costarnos en API una cuenta de prueba antes de que pague. Es el
 * tercer corte, junto con los días y los documentos: sin él, una semana de
 * consultas sin freno vale más que el primer mes de suscripción.
 */
export const TOPE_USD_PRUEBA = Number(process.env.JURIDICO_TOPE_USD_PRUEBA ?? "20") || 20;
/** Documentos de fondo incluidos por asiento y mes en el plan de paga. */
export const DOCUMENTOS_INCLUIDOS = Number(process.env.JURIDICO_DOCUMENTOS_INCLUIDOS ?? "10") || 10;

export function esPlan(v: unknown): v is PlanDespacho {
  return v === "prueba" || v === "activo" || v === "suspendido" || v === "cancelado";
}

export interface EstadoSuscripcion {
  plan: PlanDespacho;
  asientos: number;
  /** En prueba: días que quedan (0 si ya venció). */
  diasRestantes: number | null;
  /** En prueba: gasto de API acumulado y su tope, en USD. */
  gastoUsd?: number;
  topeUsd?: number;
  documentosUsados: number;
  documentosIncluidos: number;
  periodoFin: Date | null;
  /** ¿Puede trabajar ahora mismo? */
  activo: boolean;
  /** Por qué no, en español, para enseñarlo tal cual. */
  motivo?: string;
  /** true cuando queda poco y conviene avisar sin estorbar. */
  avisar: boolean;
}

/** Días completos que faltan para una fecha. Puro. */
export function diasHasta(fecha: Date | null, ahora: Date = new Date()): number | null {
  if (!fecha) return null;
  const dia = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((fecha.getTime() - ahora.getTime()) / dia));
}

/**
 * La decisión, sobre datos ya leídos. Puro: es lo que se prueba.
 *
 * En prueba se corta por lo que pase primero: días, documentos o gasto. En plan
 * de paga, pasarse de los documentos incluidos NO corta el servicio: se avisa y
 * se cobra el excedente, porque dejar a un abogado a medias de un escrito por
 * una cuota es peor negocio que facturarle un paquete.
 */
export function decidirSuscripcion(
  d: {
    plan: PlanDespacho;
    pruebaHasta: Date | null;
    asientos: number;
    periodoFin: Date | null;
    documentosDelMes: number;
    gastoUsd?: number;
    /** El despacho del operador no se corta por gasto: es nuestra propia casa. */
    sinTopeDeGasto?: boolean;
  },
  ahora: Date = new Date()
): EstadoSuscripcion {
  const dias = diasHasta(d.pruebaHasta, ahora);
  const incluidos = d.plan === "prueba" ? DOCUMENTOS_DE_PRUEBA : DOCUMENTOS_INCLUIDOS * Math.max(1, d.asientos);
  const gasto = Math.round((d.gastoUsd ?? 0) * 100) / 100;
  const base = {
    plan: d.plan,
    asientos: d.asientos,
    diasRestantes: d.plan === "prueba" ? (dias ?? 0) : null,
    documentosUsados: d.documentosDelMes,
    documentosIncluidos: incluidos,
    periodoFin: d.periodoFin,
    ...(d.plan === "prueba" ? { gastoUsd: gasto, topeUsd: TOPE_USD_PRUEBA } : {}),
  };

  if (d.plan === "activo") {
    // Un periodo vencido no corta: Stripe reintenta el cobro y el webhook
    // pasa a «suspendido» cuando de verdad falló.
    return { ...base, activo: true, avisar: d.documentosDelMes >= incluidos };
  }
  if (d.plan === "suspendido") {
    return { ...base, activo: false, avisar: true, motivo: "El pago del despacho no se pudo cobrar. Actualiza la tarjeta para seguir trabajando; tus casos y documentos están intactos." };
  }
  if (d.plan === "cancelado") {
    return { ...base, activo: false, avisar: true, motivo: "La suscripción del despacho está cancelada. Reactívala para seguir trabajando; tus casos y documentos están intactos." };
  }
  // Prueba.
  if (dias !== null && dias <= 0) {
    return { ...base, activo: false, avisar: true, motivo: `Se acabaron los ${DIAS_DE_PRUEBA} días de prueba. Activa el plan para seguir; tus casos y documentos quedan como están.` };
  }
  if (d.documentosDelMes >= DOCUMENTOS_DE_PRUEBA) {
    return { ...base, activo: false, avisar: true, motivo: `La prueba incluye ${DOCUMENTOS_DE_PRUEBA} documentos y ya los usaste. Activa el plan para seguir; lo redactado es tuyo y ahí está.` };
  }
  if (gasto >= TOPE_USD_PRUEBA && !d.sinTopeDeGasto) {
    return { ...base, activo: false, avisar: true, motivo: "Le sacaste a la prueba todo lo que trae. Activa el plan para seguir hoy mismo; tus casos y tus borradores quedan como están." };
  }
  return {
    ...base,
    activo: true,
    avisar: (dias ?? 99) <= 2 || d.documentosDelMes >= DOCUMENTOS_DE_PRUEBA - 1 || (!d.sinTopeDeGasto && gasto >= TOPE_USD_PRUEBA * 0.8),
  };
}

/** Documentos de fondo (redactados, no subidos) del despacho en el mes. */
export async function documentosDelMes(despachoId: string, desde: Date): Promise<number> {
  return prisma.juridicoDocumento.count({
    where: { caso: { despachoId }, estado: { in: ["esquema", "redactando", "borrador", "revisado"] }, createdAt: { gte: desde } },
  });
}

/**
 * Lo que la prueba nos ha costado en API, sumando a TODOS los miembros del
 * despacho. El `despachoId` de CostEvent apunta al despacho contable, no al
 * jurídico, así que se resuelve por los usuarios del despacho.
 */
export async function gastoDePruebaUsd(despachoId: string, desde: Date): Promise<number> {
  const miembros = await prisma.juridicoMiembro.findMany({ where: { despachoId }, select: { userId: true } });
  if (miembros.length === 0) return 0;
  const r = await prisma.costEvent.aggregate({
    _sum: { costoMicroUsd: true },
    where: { userId: { in: miembros.map((m) => m.userId) }, occurredAt: { gte: desde }, subtipo: { startsWith: "ai.juridico" } },
  });
  return (r._sum.costoMicroUsd ?? 0) / 1_000_000;
}

/**
 * ¿Hay un operador en el despacho? El tope de gasto de la prueba es para los
 * prospectos, no para nuestra propia casa: el 16-sep-2026 el despacho del
 * operador llevaba 49.98 USD de uso real y el tope de 20 lo dejó fuera de su
 * propio producto. Mismo criterio que `asegurarConsumoJuridico`, y se lee
 * directo de prisma para no arrastrar next-auth a las pruebas puras.
 */
export async function despachoDeOperador(despachoId: string): Promise<boolean> {
  const n = await prisma.juridicoMiembro.count({ where: { despachoId, user: { esOperador: true } } });
  return n > 0;
}

export async function estadoSuscripcion(despachoId: string, ahora: Date = new Date()): Promise<EstadoSuscripcion | null> {
  const d = await prisma.juridicoDespacho.findUnique({ where: { id: despachoId }, select: { plan: true, pruebaHasta: true, asientos: true, periodoFin: true, createdAt: true } });
  if (!d) return null;
  const inicioMes = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1));
  const desde = d.plan === "prueba" ? d.createdAt : inicioMes;
  const enPrueba = d.plan === "prueba";
  return decidirSuscripcion(
    {
      plan: (esPlan(d.plan) ? d.plan : "prueba") as PlanDespacho,
      pruebaHasta: d.pruebaHasta,
      asientos: d.asientos,
      periodoFin: d.periodoFin,
      documentosDelMes: await documentosDelMes(despachoId, desde),
      // El gasto sólo importa mientras la prueba corre: quien ya paga no tiene tope aquí.
      gastoUsd: enPrueba ? await gastoDePruebaUsd(despachoId, d.createdAt) : 0,
      sinTopeDeGasto: enPrueba ? await despachoDeOperador(despachoId) : true,
    },
    ahora
  );
}

/**
 * ¿Puede este despacho trabajar? Nunca lanza: si la base falla, deja pasar.
 * Cobrar de más una vez es mejor que dejar a un abogado parado por un problema
 * nuestro.
 */
export async function asegurarSuscripcion(despachoId: string | null): Promise<{ permitido: boolean; motivo?: string; estado?: EstadoSuscripcion }> {
  if (!despachoId) return { permitido: true };
  try {
    const estado = await estadoSuscripcion(despachoId);
    if (!estado || estado.activo) return { permitido: true, estado: estado ?? undefined };
    return { permitido: false, motivo: estado.motivo, estado };
  } catch (e) {
    reportError(e, { ruta: "juridico/suscripcion", despachoId });
    return { permitido: true };
  }
}

/** Arranca la prueba al crear el despacho. */
export function finDePrueba(ahora: Date = new Date()): Date {
  return new Date(ahora.getTime() + DIAS_DE_PRUEBA * 24 * 60 * 60 * 1000);
}
