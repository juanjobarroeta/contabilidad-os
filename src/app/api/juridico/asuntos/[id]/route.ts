import { NextResponse } from "next/server";
import { AuthzError, puedeUsarJuridico, requireUser } from "@/lib/authz";
import { actualizarAsunto, cargarAsunto } from "@/lib/juridico/asuntos";

async function autorizar(req: Request) {
  const u = await requireUser(req);
  if (!(await puedeUsarJuridico(u.id))) throw new AuthzError(403, "Tu cuenta no tiene acceso al copiloto jurídico");
  return u.id;
}
const errorDe = (e: unknown) => NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });

// GET /api/juridico/asuntos/[id] — el asunto con sus partes y decisiones.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizar(req);
  } catch (e) {
    return errorDe(e);
  }
  const { id } = await params;
  const a = await cargarAsunto(id, userId);
  if (!a) return NextResponse.json({ error: "Asunto no encontrado" }, { status: 404 });
  return NextResponse.json(a);
}

// PATCH /api/juridico/asuntos/[id] — campos del asunto; { decision } agrega una decisión; { quitarDecision: i } la quita.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizar(req);
  } catch (e) {
    return errorDe(e);
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : undefined);
  try {
    if (typeof body.quitarDecision === "number") {
      const a = await cargarAsunto(id, userId);
      if (!a) return NextResponse.json({ error: "Asunto no encontrado" }, { status: 404 });
      const { prisma } = await import("@/lib/prisma");
      const decisiones = a.decisiones.filter((_, i) => i !== body.quitarDecision);
      await prisma.juridicoCaso.update({ where: { id }, data: { decisiones: decisiones as unknown as import("@prisma/client").Prisma.InputJsonValue } });
      return NextResponse.json(await cargarAsunto(id, userId));
    }
    const a = await actualizarAsunto(id, userId, { titulo: str("titulo"), materia: str("materia"), via: str("via"), autoridad: str("autoridad"), expediente: str("expediente"), entidad: str("entidad"), cliente: str("cliente"), objetivo: str("objetivo"), decision: str("decision") });
    return NextResponse.json(a);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 400 });
  }
}
