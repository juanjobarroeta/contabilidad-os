import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { crearTareas, listarTareas } from "@/lib/juridico/tareas";

// GET /api/juridico/casos/[id]/tareas — los pendientes del caso.
// POST — uno o varios (el copiloto manda varios de un jalón).
export const dynamic = "force-dynamic";

async function esDelUsuario(casoId: string, userId: string) {
  return !!(await prisma.juridicoCaso.findFirst({ where: { id: casoId, userId }, select: { id: true } }));
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const { id } = await params;
  if (!(await esDelUsuario(id, userId))) return NextResponse.json({ error: "Caso no encontrado" }, { status: 404 });
  const url = new URL(req.url);
  return NextResponse.json({ tareas: await listarTareas(id, { soloAbiertas: url.searchParams.get("abiertas") === "1" }) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const { id } = await params;
  if (!(await esDelUsuario(id, userId))) return NextResponse.json({ error: "Caso no encontrado" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const lista = Array.isArray(body.tareas) ? (body.tareas as Record<string, unknown>[]) : [body];
  try {
    const tareas = await crearTareas(
      id,
      userId,
      lista.map((t) => ({
        titulo: String(t.titulo ?? ""),
        detalle: typeof t.detalle === "string" ? t.detalle : null,
        vence: typeof t.vence === "string" ? t.vence : null,
        prioridad: t.prioridad === "alta" || t.prioridad === "baja" ? t.prioridad : "normal",
        asignadoUserId: typeof t.asignadoUserId === "string" ? t.asignadoUserId : null,
        documentoId: typeof t.documentoId === "string" ? t.documentoId : null,
      })),
      { userId }
    );
    if (tareas.length === 0) return NextResponse.json({ error: "Ninguna tarea tenía título." }, { status: 400 });
    return NextResponse.json({ tareas }, { status: 201 });
  } catch (e) {
    return respuestaDeError(e);
  }
}
