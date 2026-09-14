// La herramienta con la que el copiloto PROPONE pendientes. Propone, no manda:
// todo lo que crea nace con origen «copiloto» y sin responsable, para que el
// abogado lo asigne o lo borre. Vive aparte de tareas.ts para que la capa de
// datos no dependa del SDK.
import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { crearTareas, listarTareas, urgencia } from "./tareas";

export const NOMBRES_TAREAS = new Set(["proponer_tareas", "consultar_tareas"]);

export const toolsTareas: Anthropic.Tool[] = [
  {
    name: "proponer_tareas",
    description:
      "Propone PENDIENTES del caso para que el abogado los asigne: «redactar cláusulas 4 a 9», «pedir la CSF al cliente», «contestar el requerimiento», «revisar el acta de entrega». Úsala cuando el trabajo se parta en pasos que alguien tendrá que hacer después —al terminar un esquema, al leer un acuerdo o una demanda con plazos, o cuando el abogado diga qué falta—. No inventes fechas: pon `vence` sólo si el documento o el usuario la dicen. Quedan marcadas como propuestas del copiloto.",
    input_schema: {
      type: "object",
      properties: {
        tareas: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              titulo: { type: "string", description: "Qué hay que hacer, en imperativo y concreto." },
              detalle: { type: "string", description: "Contexto útil: de dónde sale, qué se necesita." },
              vence: { type: "string", description: "AAAA-MM-DD. Sólo si una fecha o un plazo la determinan." },
              prioridad: { type: "string", enum: ["baja", "normal", "alta"] },
            },
            required: ["titulo"],
          },
        },
      },
      required: ["tareas"],
    },
  },
  {
    name: "consultar_tareas",
    description: "Devuelve los pendientes abiertos del caso con su estado, responsable y vencimiento. Úsala antes de proponer tareas nuevas (para no repetir) y cuando el abogado pregunte qué falta o qué está por vencer.",
    input_schema: { type: "object", properties: {} },
  },
];

export async function ejecutarHerramientaTareas(nombre: string, input: Record<string, unknown>, ctx: { userId: string; conversacionId: string }): Promise<string> {
  const conv = await prisma.juridicoConversacion.findFirst({ where: { id: ctx.conversacionId, userId: ctx.userId }, select: { casoId: true } });
  const casoId = conv?.casoId ?? null;
  if (!casoId) {
    return JSON.stringify({ aviso: "La conversación todavía no pertenece a un caso; registra las partes o el asunto primero y vuelve a intentar.", resumen: "sin caso" });
  }

  if (nombre === "consultar_tareas") {
    const tareas = await listarTareas(casoId, { soloAbiertas: true });
    return JSON.stringify({
      tareas: tareas.map((t) => ({ titulo: t.titulo, estado: t.estado, prioridad: t.prioridad, vence: t.vence?.toISOString().slice(0, 10) ?? null, urgencia: urgencia(t).estado, asignada: !!t.asignadoUserId })),
      resumen: tareas.length === 0 ? "sin pendientes abiertos" : `${tareas.length} pendiente(s) abierto(s)`,
    });
  }

  const lista = Array.isArray(input.tareas) ? (input.tareas as Record<string, unknown>[]) : [];
  const creadas = await crearTareas(
    casoId,
    ctx.userId,
    lista.map((t) => ({
      titulo: String(t.titulo ?? ""),
      detalle: typeof t.detalle === "string" ? t.detalle : null,
      vence: typeof t.vence === "string" ? t.vence : null,
      prioridad: t.prioridad === "alta" || t.prioridad === "baja" ? t.prioridad : "normal",
      origen: "copiloto" as const,
    })),
    { userId: ctx.userId, tipo: "copiloto" }
  );
  return JSON.stringify({
    creadas: creadas.map((t) => ({ id: t.id, titulo: t.titulo, vence: t.vence?.toISOString().slice(0, 10) ?? null })),
    resumen: creadas.length === 0 ? "ninguna tarea tenía título" : `${creadas.length} pendiente(s) propuesto(s)`,
    aviso: "Quedan como propuestas sin responsable: el abogado las asigna o las borra en el caso.",
  });
}
