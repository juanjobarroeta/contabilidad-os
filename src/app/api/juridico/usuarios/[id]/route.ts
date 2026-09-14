import { NextResponse } from "next/server";
import { AuthzError, isOperador, requireUser } from "@/lib/authz";
import { respuestaDeError } from "@/lib/juridico/api-guardia";
import { restablecerContrasena, revocarAcceso } from "@/lib/juridico/usuarios";

// PATCH /api/juridico/usuarios/[id] { restablecer: true } — contraseña nueva,
// se enseña una vez. DELETE — quita el acceso sin borrar la cuenta ni sus
// casos: un despacho no puede perder el expediente porque alguien se fue.
export const dynamic = "force-dynamic";

async function autorizarOperador(req: Request): Promise<string> {
  const u = await requireUser(req);
  if (!(await isOperador(u.id))) throw new AuthzError(403, "Sólo el operador administra los asientos del copiloto jurídico.");
  return u.id;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await autorizarOperador(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.restablecer !== true) return NextResponse.json({ error: "Manda { restablecer: true }." }, { status: 400 });
  try {
    return NextResponse.json({ contrasenaTemporal: await restablecerContrasena(id) });
  } catch (e) {
    return respuestaDeError(e);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await autorizarOperador(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const { id } = await params;
  try {
    await revocarAcceso(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return respuestaDeError(e);
  }
}
