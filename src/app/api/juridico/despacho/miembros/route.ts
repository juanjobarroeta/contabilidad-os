import { NextResponse } from "next/server";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { asegurarDespacho, esRol, invitar, listarMiembros, puede } from "@/lib/juridico/despacho";

// GET /api/juridico/despacho/miembros — el equipo.
// POST { email, nombre, rol } — suma a alguien: si no tiene cuenta se le crea
// con acceso al copiloto y contraseña temporal, que se enseña UNA vez. Lo hace
// el socio; ya no hace falta que nosotros corramos un script.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const d = await asegurarDespacho(userId);
  return NextResponse.json({ miembros: await listarMiembros(d.despachoId) });
}

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const d = await asegurarDespacho(userId);
  if (!puede(d.rol, "administrarDespacho")) return NextResponse.json({ error: "Sólo un socio suma gente al despacho." }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const r = await invitar(d.despachoId, { email: String(body.email ?? ""), nombre: String(body.nombre ?? ""), rol: esRol(body.rol) ? body.rol : undefined });
    return NextResponse.json(r, { status: r.yaExistia ? 200 : 201 });
  } catch (e) {
    return respuestaDeError(e);
  }
}
