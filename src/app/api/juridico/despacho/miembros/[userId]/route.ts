import { NextResponse } from "next/server";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { asegurarDespacho, cambiarRol, esRol, puede, quitarMiembro } from "@/lib/juridico/despacho";
import { prohibido } from "@/lib/juridico/errores-api";

// PATCH /api/juridico/despacho/miembros/[userId] { rol } — cambia el papel.
// DELETE — lo saca del despacho. Ni una ni otra borran su cuenta ni los casos
// que trabajó: un despacho no puede perder el expediente porque alguien se fue.
// Un despacho nunca se queda sin socio.
export const dynamic = "force-dynamic";

async function socioDe(req: Request) {
  const yo = await autorizarJuridico(req);
  const d = await asegurarDespacho(yo);
  if (!puede(d.rol, "administrarDespacho")) throw prohibido("Sólo un socio administra el equipo del despacho.");
  return d;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const d = await socioDe(req);
    const { userId } = await params;
    const body = (await req.json().catch(() => ({}))) as { rol?: unknown };
    if (!esRol(body.rol)) return NextResponse.json({ error: "Papel inválido: socio, abogado, pasante o administrativo." }, { status: 400 });
    await cambiarRol(d.despachoId, userId, body.rol);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return respuestaDeError(e);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const d = await socioDe(req);
    const { userId } = await params;
    await quitarMiembro(d.despachoId, userId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return respuestaDeError(e);
  }
}
