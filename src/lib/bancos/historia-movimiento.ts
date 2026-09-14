import { prisma } from "@/lib/prisma";
import { historiaDeEntidad, type RazonDecision } from "@/lib/decisiones";

// ─────────────────────────────────────────────────────────────────────────────
// LA HISTORIA DE UN MOVIMIENTO — lo que le pasó y por qué.
//
// La mesa de conciliación enseñaba el estado final de un movimiento («conciliado
// con la factura A») y nada más. Lo que faltaba es lo que un contador pregunta
// primero: quién lo decidió, con qué lo comparó y por qué descartó lo demás.
//
// Aquí se juntan las dos fuentes que ya existen y nunca se habían cruzado:
//
//   · DecisionMotor — el razonamiento de los motores (F0). Trae las reglas en
//     palabras: «el lote del banco es de crédito y la factura declara débito».
//   · AuditLog — lo que hicieron las personas: conciliar a mano, deshacer,
//     editar. Sin esto la historia contaría la mitad y parecería que el sistema
//     se mueve solo.
//
// El orden es cronológico inverso: lo último que pasó es lo que explica el
// estado de hoy, y es lo que se lee primero.
// ─────────────────────────────────────────────────────────────────────────────

export type OrigenHistoria = "motor" | "persona";

export interface EventoHistoria {
  id: string;
  fecha: Date;
  origen: OrigenHistoria;
  /** Quién: el nombre del motor, o el correo de quien lo hizo. */
  autor: string;
  /** Qué pasó, en una línea. */
  titulo: string;
  /** El porqué. Vacío para los eventos de bitácora, que no razonan. */
  razones: RazonDecision[];
  /** Metadatos del evento (resultado del motor, detalle de la bitácora). */
  datos: unknown;
}

/** Cómo se lee cada acción de la bitácora en la línea del tiempo. */
const TITULO_BITACORA: Record<string, string> = {
  "conciliacion.match": "Conciliado a mano",
  "conciliacion.unmatch": "Desconciliado a mano",
  "conciliacion.match-impuesto": "Conciliado contra una declaración",
  "conciliacion.devolucion": "Vinculado a una devolución",
  "conciliacion.devolucion-desvincular": "Desvinculado de la devolución",
  "bancos.edit-transaction": "Editado a mano",
  "bancos.delete-transaction": "Eliminado",
};

/** Cómo se lee cada acción de un motor. */
const TITULO_MOTOR: Record<string, string> = {
  match: "Conciliado por el motor",
  rechazo: "El motor no lo concilió",
};

function tituloDeMotor(motor: string, accion: string): string {
  return TITULO_MOTOR[accion] ?? `${motor}: ${accion}`;
}

interface FilaDecision {
  id: string;
  createdAt: Date;
  motor: string;
  actor: string;
  actorId: string | null;
  accion: string;
  resultado: unknown;
  razones: RazonDecision[];
}

interface FilaBitacora {
  id: string;
  createdAt: Date;
  accion: string;
  actorEmail: string | null;
  detalle: unknown;
}

/**
 * Mezcla las dos fuentes en una sola línea del tiempo. PURA.
 *
 * Se separa de las consultas para poder probar el orden y la redacción sin base
 * de datos, que es la disciplina del resto del módulo.
 */
export function fusionarHistoria(
  decisiones: FilaDecision[],
  bitacora: FilaBitacora[],
): EventoHistoria[] {
  const deMotor: EventoHistoria[] = decisiones.map((d) => ({
    id: d.id,
    fecha: d.createdAt,
    // `actor` distingue al motor de una acción tomada por una persona a través
    // de él: el rastro lo guarda, así que la historia no tiene que suponerlo.
    origen: d.actor === "motor" ? "motor" : "persona",
    autor: d.actor === "motor" ? d.motor : (d.actorId ?? d.actor),
    titulo: tituloDeMotor(d.motor, d.accion),
    razones: d.razones,
    datos: d.resultado ?? null,
  }));

  const dePersona: EventoHistoria[] = bitacora.map((b) => ({
    id: b.id,
    fecha: b.createdAt,
    origen: "persona",
    autor: b.actorEmail ?? "alguien del equipo",
    titulo: TITULO_BITACORA[b.accion] ?? b.accion,
    razones: [],
    datos: b.detalle ?? null,
  }));

  return [...deMotor, ...dePersona].sort((a, b) => b.fecha.getTime() - a.fecha.getTime());
}

/**
 * La historia completa de un movimiento.
 *
 * El `companyId` no es decorativo: entra en los índices de ambas tablas y es el
 * candado de inquilino. La bitácora no tiene FK a Company a propósito (es
 * bitácora de seguridad), así que filtrar por empresa aquí es obligatorio.
 */
export async function historiaDeMovimiento(
  companyId: string,
  txId: string,
  limite = 50,
): Promise<EventoHistoria[]> {
  const [decisiones, bitacora] = await Promise.all([
    historiaDeEntidad(companyId, "BankTransaction", txId, limite),
    prisma.auditLog.findMany({
      where: { companyId, entidad: "BankTransaction", entidadId: txId },
      orderBy: { createdAt: "desc" },
      take: limite,
      select: { id: true, createdAt: true, accion: true, actorEmail: true, detalle: true },
    }),
  ]);
  return fusionarHistoria(decisiones, bitacora);
}
