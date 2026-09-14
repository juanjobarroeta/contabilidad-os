import { NextResponse } from "next/server";
import { AuthzError, isOperador, requireUser } from "@/lib/authz";
import { respuestaDeError } from "@/lib/juridico/api-guardia";
import { crearAsiento, listarAsientos } from "@/lib/juridico/usuarios";

// GET /api/juridico/usuarios — los asientos del copiloto jurídico, con su
// consumo del mes. POST — da de alta uno (sustituye al script que se corría
// a mano contra la base).
//
// Sólo el operador: dar de alta una cuenta es crear acceso al producto, no
// una acción del abogado. Cuando el despacho sea la cuenta (Fase 1, siguiente
// paso) el socio podrá invitar a su equipo.
export const dynamic = "force-dynamic";

async function autorizarOperador(req: Request): Promise<string> {
  const u = await requireUser(req);
  if (!(await isOperador(u.id))) throw new AuthzError(403, "Sólo el operador administra los asientos del copiloto jurídico.");
  return u.id;
}

export async function GET(req: Request) {
  try {
    await autorizarOperador(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const url = new URL(req.url);
  return NextResponse.json({ asientos: await listarAsientos({ conConsumo: url.searchParams.get("consumo") === "1" }) });
}

export async function POST(req: Request) {
  try {
    await autorizarOperador(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const r = await crearAsiento({ email: String(body.email ?? ""), nombre: String(body.nombre ?? body.name ?? "") });
    return NextResponse.json(r, { status: r.yaExistia ? 200 : 201 });
  } catch (e) {
    return respuestaDeError(e);
  }
}
