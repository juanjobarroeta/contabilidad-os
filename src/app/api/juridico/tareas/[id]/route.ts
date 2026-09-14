import { NextResponse } from "next/server";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { actualizarTarea, eliminarTarea, esEstado, esPrioridad } from "@/lib/juridico/tareas";

// PATCH /api/juridico/tareas/[id] — mover, asignar, cambiar fecha o texto.
// DELETE — quitarla.
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
  try {
    const t = await actualizarTarea(
      id,
      userId,
      {
        ...(esEstado(body.estado) ? { estado: body.estado } : {}),
        ...(esPrioridad(body.prioridad) ? { prioridad: body.prioridad } : {}),
        ...(typeof body.titulo === "string" ? { titulo: body.titulo } : {}),
        ...("detalle" in body ? { detalle: typeof body.detalle === "string" ? body.detalle : null } : {}),
        ...("vence" in body ? { vence: typeof body.vence === "string" ? body.vence : null } : {}),
        ...("asignadoUserId" in body ? { asignadoUserId: typeof body.asignadoUserId === "string" ? body.asignadoUserId : null } : {}),
      },
      { userId }
    );
    return NextResponse.json(t);
  } catch (e) {
    return respuestaDeError(e);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const { id } = await params;
  try {
    await eliminarTarea(id, userId, { userId });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return respuestaDeError(e);
  }
}
