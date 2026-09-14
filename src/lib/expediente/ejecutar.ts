import { esConfianza, esTema, esTipoNota, type Confianza, type TemaExpediente, type TipoNota } from "./claves";
import { registrarHecho } from "./hechos";
import { anotar, resolverNota } from "./notas";
import { cargarExpediente } from "./cargar";
import { valorEnTexto } from "./prompt";

// ─────────────────────────────────────────────────────────────────────────────
// La EJECUCIÓN de las herramientas del expediente.
//
// Vive aparte de `tools.ts` a propósito: las definiciones son datos puros y las
// importa cualquiera que arme un prompt (el copiloto, WhatsApp, el eval),
// mientras que esto toca Prisma. Juntarlas arrastraría la base de datos al
// bundle de todo el que sólo quería la lista de herramientas.
// ─────────────────────────────────────────────────────────────────────────────

export interface CtxExpediente {
  companyId: string;
  userId?: string | null;
  /** "agente" en la pasada diaria, "usuario" cuando lo dicta una persona en el chat. */
  autor?: "agente" | "usuario";
}

/** Ejecuta una herramienta del expediente. Devuelve el JSON que ve el modelo. */
export async function ejecutarHerramientaExpediente(
  nombre: string,
  input: Record<string, unknown>,
  ctx: CtxExpediente,
): Promise<string> {
  const autor = ctx.autor ?? "agente";
  const texto = (k: string): string | undefined =>
    typeof input[k] === "string" && (input[k] as string).trim() ? (input[k] as string).trim() : undefined;
  const lista = (k: string): string[] =>
    Array.isArray(input[k]) ? (input[k] as unknown[]).filter((x): x is string => typeof x === "string") : [];

  if (nombre === "consultar_expediente") {
    const e = await cargarExpediente(ctx.companyId);
    return JSON.stringify({
      hechos: e.hechos.map((h) => ({
        clave: h.clave,
        valor: valorEnTexto(h.valor),
        desde: h.vigenteDesde,
        confianza: h.confianza,
        verificado: h.verificado,
      })),
      pendientes: e.pendientes.map((n) => ({ id: n.id, tema: n.tema, titulo: n.titulo, cuerpo: n.cuerpo, desde: n.createdAt, refs: n.refs })),
      notas: e.notas.map((n) => ({ id: n.id, tipo: n.tipo, tema: n.tema, titulo: n.titulo, cuerpo: n.cuerpo, fecha: n.createdAt, refs: n.refs })),
      resumen: `${e.hechos.length} hechos vigentes, ${e.pendientes.length} compromisos abiertos`,
    });
  }

  if (nombre === "registrar_hecho") {
    const clave = texto("clave");
    const valor = texto("valor");
    if (!clave || !valor) return JSON.stringify({ error: "Faltan clave o valor." });
    const confianza: Confianza = esConfianza(input.confianza) ? input.confianza : "media";
    const r = await registrarHecho({
      companyId: ctx.companyId,
      clave: clave.toLowerCase(),
      valor,
      // El modelo nunca escribe como "usuario": eso volvería su inferencia
      // inmutable frente a los motores y frente a sí mismo, y le dejaría pisar
      // lo que una persona ya había verificado.
      fuente: "agente",
      evidencia: lista("evidencia"),
      confianza,
    });
    return JSON.stringify({
      clave,
      accion: r.accion,
      // El motivo se devuelve tal cual para que el modelo NO afirme que guardó
      // algo que en realidad se ignoró por estar verificado a mano.
      motivo: r.motivo,
      resumen: r.accion === "ignorar" ? `No se cambió: ${r.motivo}` : `Hecho ${r.accion === "crear" ? "registrado" : "actualizado"}.`,
    });
  }

  if (nombre === "anotar_expediente") {
    const titulo = texto("titulo");
    const cuerpo = texto("cuerpo");
    if (!titulo || !cuerpo) return JSON.stringify({ error: "Faltan título o cuerpo." });
    const tipo: TipoNota = esTipoNota(input.tipo) && input.tipo !== "resumen_corrida" ? input.tipo : "observacion";
    const tema: TemaExpediente = esTema(input.tema) ? input.tema : "general";
    const n = await anotar({
      companyId: ctx.companyId,
      autor,
      autorId: ctx.userId ?? null,
      tipo,
      tema,
      titulo,
      cuerpo,
      refs: lista("refs"),
    });
    return JSON.stringify({
      nota_id: n.id,
      tipo: n.tipo,
      estado: n.estado,
      resumen: n.tipo === "pendiente" ? "Pendiente abierto: la siguiente corrida lo leerá primero." : "Anotado en el expediente.",
    });
  }

  if (nombre === "cerrar_pendiente") {
    const notaId = texto("nota_id");
    const porque = texto("porque");
    if (!notaId || !porque) return JSON.stringify({ error: "Faltan nota_id o porque." });
    // La explicación se escribe ANTES de cerrar y queda enlazada: un pendiente
    // cerrado sin motivo es indistinguible de uno que alguien silenció.
    const cierre = await anotar({
      companyId: ctx.companyId,
      autor,
      autorId: ctx.userId ?? null,
      tipo: "observacion",
      tema: "general",
      titulo: "Se cerró un pendiente",
      cuerpo: porque,
      refs: [notaId],
    });
    const n = await resolverNota(ctx.companyId, notaId, { porNotaId: cierre.id });
    if (!n) return JSON.stringify({ error: "Ese pendiente no existe o ya estaba cerrado.", nota_id: notaId });
    return JSON.stringify({ nota_id: n.id, estado: n.estado, resumen: "Pendiente cerrado con su motivo." });
  }

  return JSON.stringify({ error: `Herramienta de expediente desconocida: ${nombre}` });
}
