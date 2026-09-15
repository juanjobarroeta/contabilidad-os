// La herramienta con la que el copiloto PROPONE plazos. Propone, nunca decide:
// lo que crea nace en estado `propuesto` y sólo un abogado lo confirma.
//
// El modelo aporta lo que sabe leer del expediente —la fecha de notificación,
// cuántos días da el artículo, si son hábiles o naturales— y el cómputo lo hace
// código puro y probado, no el modelo. Ésa es la división que importa: un
// modelo que cuenta días saltándose festivos se equivoca sin avisar.
import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { reportError } from "@/lib/observability";
import { despachoDe } from "./despacho";
import { crearPlazo, esFuero, esSurte, esTipoDias, listarPlazos, simular } from "./plazos-datos";
import { explicacion } from "./plazos";

export const NOMBRES_PLAZOS = new Set(["proponer_plazo", "consultar_plazos"]);

const ESQUEMA_PLAZO = {
  type: "object" as const,
  properties: {
    titulo: { type: "string", description: "Qué hay que presentar y ante quién: «Contestar la demanda», «Interponer amparo directo»." },
    fuero: {
      type: "string",
      enum: ["amparo", "laboral", "federal", "local"],
      description:
        "De qué calendario de días inhábiles se trata. NO son iguales: el amparo usa las fechas del Art. 19 de la Ley de Amparo (5 de febrero, 21 de marzo, 20 de noviembre, más 5 de mayo, 14 de septiembre y 12 de octubre) y el laboral usa los días de descanso obligatorio del Art. 74 de la LFT, que se conmemoran en lunes.",
    },
    entidad: { type: "string", description: "Clave de la entidad (PUE, CMX, NLE…) cuando el fuero es local." },
    notificacion: { type: "string", description: "AAAA-MM-DD: el día en que se practicó la notificación. Sácalo del acuerdo o pregúntalo; no lo inventes." },
    dias: { type: "integer", description: "Cuántos días da el artículo." },
    tipo: { type: "string", enum: ["habiles", "naturales"], description: "Si el artículo dice «días» sin más, en materia procesal suelen ser hábiles." },
    surteEfectos: { type: "string", enum: ["mismo_dia", "dia_siguiente_habil"], description: "Cuándo surte efectos la notificación según la vía. En amparo suele ser al día hábil siguiente." },
    fundamento: { type: "string", description: "El artículo que da el plazo, citado: «Art. 17 de la Ley de Amparo»." },
    articulo: { type: "string", description: "Número de artículo." },
    ordenamiento: { type: "string", description: "Clave del ordenamiento en el catálogo, si la tienes de una búsqueda." },
  },
  required: ["titulo", "fuero", "notificacion", "dias"],
};

export const toolsPlazos: Anthropic.Tool[] = [
  {
    name: "proponer_plazo",
    description:
      "Computa y registra un PLAZO PROCESAL del caso a partir de la fecha de notificación y del artículo que lo funda. Úsala cuando leas un acuerdo, un emplazamiento o una sentencia que abra un término, o cuando el abogado pregunte para cuándo vence algo. El cómputo lo hace el sistema con el calendario de días inhábiles del fuero: TÚ NO CUENTES LOS DÍAS, sólo aporta la fecha de notificación, cuántos días da el artículo y cuál es. El plazo queda PROPUESTO hasta que el abogado lo confirme. Si no sabes la fecha exacta de notificación, pregúntala en vez de suponerla.",
    input_schema: { ...ESQUEMA_PLAZO, properties: { ...ESQUEMA_PLAZO.properties, simular: { type: "boolean", description: "true para sólo ver el cómputo sin registrarlo." } } },
  },
  {
    name: "consultar_plazos",
    description: "Devuelve los plazos abiertos del caso con su vencimiento, su fundamento y si ya los confirmó un abogado. Úsala antes de proponer uno nuevo, para no duplicar, y cuando pregunten qué está por vencer.",
    input_schema: { type: "object", properties: {} },
  },
];

export async function ejecutarHerramientaPlazos(nombre: string, input: Record<string, unknown>, ctx: { userId: string; conversacionId: string }): Promise<string> {
  const conv = await prisma.juridicoConversacion.findFirst({ where: { id: ctx.conversacionId, userId: ctx.userId }, select: { casoId: true } });
  const casoId = conv?.casoId ?? null;
  if (!casoId) {
    return JSON.stringify({ aviso: "La conversación todavía no pertenece a un caso; registra el asunto primero y vuelve a intentar.", resumen: "sin caso" });
  }

  if (nombre === "consultar_plazos") {
    const plazos = await listarPlazos(casoId, { despachoId: (await despachoDe(ctx.userId))?.despachoId ?? null });
    return JSON.stringify({
      plazos: plazos.map((p) => ({ titulo: p.titulo, vence: p.vence, diasHabilesRestantes: p.diasHabilesRestantes, estado: p.estado, fundamento: p.fundamento })),
      resumen: plazos.length === 0 ? "sin plazos registrados" : `${plazos.length} plazo(s) abierto(s)`,
    });
  }

  if (!esFuero(input.fuero)) return JSON.stringify({ error: "Falta el fuero: amparo, laboral, federal o local." });
  const notificacion = String(input.notificacion ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(notificacion)) {
    return JSON.stringify({ error: "La fecha de notificación va como AAAA-MM-DD. Si no la sabes, pregúntasela al abogado en vez de suponerla." });
  }
  const datos = {
    titulo: String(input.titulo ?? ""),
    fuero: input.fuero,
    entidad: typeof input.entidad === "string" ? input.entidad : null,
    notificacion,
    dias: Number(input.dias),
    tipo: esTipoDias(input.tipo) ? input.tipo : undefined,
    surteEfectos: esSurte(input.surteEfectos) ? input.surteEfectos : undefined,
    fundamento: typeof input.fundamento === "string" ? input.fundamento : null,
    articulo: typeof input.articulo === "string" ? input.articulo : null,
    ordenamiento: typeof input.ordenamiento === "string" ? input.ordenamiento : null,
    origen: "copiloto" as const,
  };
  const despachoId = (await despachoDe(ctx.userId))?.despachoId ?? null;

  try {
    if (input.simular === true) {
      const c = await simular({ ...datos, despachoId });
      return JSON.stringify({ computo: explicacion(c), vence: c.vence, advertencias: c.advertencias, resumen: "sólo simulado, no se registró" });
    }
    const p = await crearPlazo(casoId, ctx.userId, datos, { userId: ctx.userId, tipo: "copiloto" }, despachoId);
    return JSON.stringify({
      id: p.id,
      titulo: p.titulo,
      vence: p.vence,
      computo: p.explicacion,
      diasHabilesRestantes: p.diasHabilesRestantes,
      advertencias: p.advertencias,
      resumen: `plazo propuesto: vence el ${p.vence}`,
      aviso: "Queda PROPUESTO. Dile al abogado que lo confirme en el caso, y que el calendario no incluye suspensiones de labores del órgano.",
    });
  } catch (e) {
    // El error se le devuelve AL MODELO, que se lo dirá al abogado. Tiene que
    // ser una frase que sirva, no un volcado de Prisma.
    const msg = e instanceof Error ? e.message : "";
    const conocido = msg && msg.length < 200 && !msg.includes("\n");
    reportError(e, { ruta: "juridico/plazos-tool", casoId });
    return JSON.stringify({ error: conocido ? msg : "No se pudo registrar el plazo. Dile al abogado que lo capture a mano en el caso y que el cómputo quedó pendiente." });
  }
}
