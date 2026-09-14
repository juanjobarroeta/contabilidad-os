// Autorización compartida por las rutas del copiloto jurídico: sesión o bearer
// del satélite, y acceso al módulo. Estaba copiada en cada ruta.
import { NextResponse } from "next/server";
import { AuthzError, puedeUsarJuridico, requireUser } from "@/lib/authz";
import { reportError } from "@/lib/observability";
import { ErrorJuridico } from "./errores-api";

export async function autorizarJuridico(req: Request): Promise<string> {
  const u = await requireUser(req);
  if (!(await puedeUsarJuridico(u.id))) throw new AuthzError(403, "Tu cuenta no tiene acceso al copiloto jurídico");
  return u.id;
}

/**
 * El error que sale por la ruta. Regla: nunca contestar 401 por algo que no es
 * de autenticación — «el despacho se quedaría sin socio» salía como
 * «Unauthorized», que miente y esconde el motivo.
 */
export function respuestaDeError(e: unknown): NextResponse {
  if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
  if (e instanceof ErrorJuridico) return NextResponse.json({ error: e.message }, { status: e.status });
  const msg = e instanceof Error ? e.message : "Error";
  // Reglas escritas antes de ErrorJuridico, por si queda alguna suelta.
  if (/no encontrad[oa]/i.test(msg)) return NextResponse.json({ error: msg }, { status: 404 });
  if (/no puede pasar|necesita|inválid|se quedaría|sólo un socio/i.test(msg)) return NextResponse.json({ error: msg }, { status: 400 });
  // Lo que no sabemos explicar es nuestro, no del que llama.
  reportError(e, { ruta: "juridico/api" });
  return NextResponse.json({ error: "No se pudo completar la operación." }, { status: 500 });
}
