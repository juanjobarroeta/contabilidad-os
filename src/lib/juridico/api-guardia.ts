// Autorización compartida por las rutas del copiloto jurídico: sesión o bearer
// del satélite, y acceso al módulo. Estaba copiada en cada ruta.
import { NextResponse } from "next/server";
import { AuthzError, puedeUsarJuridico, requireUser } from "@/lib/authz";

export async function autorizarJuridico(req: Request): Promise<string> {
  const u = await requireUser(req);
  if (!(await puedeUsarJuridico(u.id))) throw new AuthzError(403, "Tu cuenta no tiene acceso al copiloto jurídico");
  return u.id;
}

export function respuestaDeError(e: unknown): NextResponse {
  if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
  const msg = e instanceof Error ? e.message : "Error";
  if (/no encontrad[oa]/i.test(msg)) return NextResponse.json({ error: msg }, { status: 404 });
  if (/no puede pasar|necesita|inválid/i.test(msg)) return NextResponse.json({ error: msg }, { status: 400 });
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
