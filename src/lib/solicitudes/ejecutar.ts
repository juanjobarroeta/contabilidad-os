import { esTipoSolicitud, etiquetaPeriodo, tituloDeTipo } from "./claves";
import { abrirSolicitud, solicitudesAbiertas } from "./registro";

// ─────────────────────────────────────────────────────────────────────────────
// La ejecución de las herramientas de solicitudes. Aparte de sus definiciones,
// por la misma razón que en el expediente: las definiciones las importa
// cualquiera que arme un prompt, y esto toca Prisma.
// ─────────────────────────────────────────────────────────────────────────────

export interface CtxSolicitudes {
  companyId: string;
  origen?: "agente" | "usuario";
}

export async function ejecutarHerramientaSolicitud(
  nombre: string,
  input: Record<string, unknown>,
  ctx: CtxSolicitudes,
): Promise<string> {
  if (nombre === "consultar_solicitudes") {
    const abiertas = await solicitudesAbiertas(ctx.companyId);
    return JSON.stringify({
      solicitudes: abiertas.map((s) => ({
        id: s.id,
        tipo: s.tipo,
        titulo: tituloDeTipo(s.tipo),
        periodo: s.periodo,
        motivo: s.motivo,
        pedida: s.createdAt,
        refs: s.refs,
      })),
      resumen: abiertas.length === 0 ? "No hay nada pendiente del cliente." : `${abiertas.length} pedidos abiertos.`,
    });
  }

  if (nombre === "solicitar_al_cliente") {
    if (!esTipoSolicitud(input.tipo)) return JSON.stringify({ error: "tipo inválido" });
    const detalle = typeof input.detalle === "string" ? input.detalle.trim() : "";
    if (!detalle) return JSON.stringify({ error: "Falta el detalle: sin él el cliente no sabe qué mandar." });
    const periodo = typeof input.periodo === "string" && /^\d{4}-\d{2}$/.test(input.periodo) ? input.periodo : null;
    const refs = Array.isArray(input.refs)
      ? (input.refs as unknown[]).filter((x): x is string => typeof x === "string")
      : [];

    // La llave se arma con lo que IDENTIFICA el pedido, nunca con la hora: si
    // llevara marca de tiempo, el agente abriría el mismo pedido cada pasada.
    const dedupeKey = `agente:${input.tipo}:${periodo ?? "sin-periodo"}:${refs[0] ?? detalle.slice(0, 40)}`;

    const r = await abrirSolicitud({
      companyId: ctx.companyId,
      tipo: input.tipo,
      dedupeKey,
      refs,
      periodo,
      detalle,
      origen: ctx.origen ?? "agente",
    });
    return JSON.stringify({
      solicitud_id: r.solicitud.id,
      nueva: r.nueva,
      titulo: tituloDeTipo(r.solicitud.tipo),
      periodo: r.solicitud.periodo ? etiquetaPeriodo(r.solicitud.periodo) : null,
      // Si ya existía, el modelo NO debe decirle al usuario que acaba de pedirlo:
      // lo útil entonces es desde cuándo se está esperando.
      resumen: r.nueva
        ? "Solicitud abierta: aparece en la mesa junto a los movimientos que la motivan."
        : `Ya estaba pedida desde ${r.solicitud.createdAt.toISOString().slice(0, 10)}; no se duplicó.`,
    });
  }

  return JSON.stringify({ error: `Herramienta de solicitudes desconocida: ${nombre}` });
}
