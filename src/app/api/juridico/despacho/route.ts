import { NextResponse } from "next/server";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { asegurarDespacho, listarMiembros, puede, renombrar } from "@/lib/juridico/despacho";

// GET /api/juridico/despacho — el despacho del abogado y su equipo. Si es su
// primera vez, se le crea uno (él como socio) y sus casos se mudan ahí: no hay
// un paso de «crea tu despacho» que nadie quiere hacer.
// PATCH { nombre } — renombrarlo (sólo socio).
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const d = await asegurarDespacho(userId);
  return NextResponse.json({ despacho: d, miembros: await listarMiembros(d.despachoId), puedo: { administrar: puede(d.rol, "administrarDespacho"), cerrarCaso: puede(d.rol, "cerrarCaso"), redactar: puede(d.rol, "redactar") } });
}

export async function PATCH(req: Request) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const d = await asegurarDespacho(userId);
  if (!puede(d.rol, "administrarDespacho")) return NextResponse.json({ error: "Sólo un socio cambia los datos del despacho." }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { nombre?: unknown };
  try {
    await renombrar(d.despachoId, String(body.nombre ?? ""));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return respuestaDeError(e);
  }
}
