import { NextResponse } from "next/server";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { despachoDe } from "@/lib/juridico/despacho";
import { cambiarEstadoPlazo, recomputarPlazo } from "@/lib/juridico/plazos-datos";

// PATCH /api/juridico/plazos/[id] — confirmar, marcar cumplido o descartar.
//   { estado: "confirmado" | "cumplido" | "descartado", nota? }
//   Al confirmar se puede pedir la TAREA que lo persigue, con dueño y con
//   recordatorio en días HÁBILES antes del vencimiento:
//   { estado: "confirmado", tarea: { asignadoUserId?, diasAntes?, titulo? } }
//   { recomputar: true } vuelve a correr el cómputo con el calendario de hoy,
//   que es lo que hace falta cuando el juzgado publica una suspensión.
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const nota = typeof body.nota === "string" ? body.nota : undefined;
  try {
    if (body.recomputar === true) {
      const despachoId = (await despachoDe(userId))?.despachoId ?? null;
      return NextResponse.json({ plazo: await recomputarPlazo(id, userId, { userId }, despachoId) });
    }
    const estado = body.estado;
    if (estado !== "confirmado" && estado !== "cumplido" && estado !== "descartado") {
      return NextResponse.json({ error: "El estado va como confirmado, cumplido o descartado." }, { status: 400 });
    }
    const t = body.tarea as Record<string, unknown> | undefined;
    const tarea = t && typeof t === "object"
      ? {
          asignadoUserId: typeof t.asignadoUserId === "string" ? t.asignadoUserId : null,
          diasAntes: Number.isFinite(Number(t.diasAntes)) ? Number(t.diasAntes) : 0,
          titulo: typeof t.titulo === "string" ? t.titulo : undefined,
        }
      : undefined;
    const despachoId = tarea ? (await despachoDe(userId))?.despachoId ?? null : null;
    return NextResponse.json({ plazo: await cambiarEstadoPlazo(id, userId, estado, { userId }, nota, tarea, despachoId) });
  } catch (e) {
    return respuestaDeError(e);
  }
}
