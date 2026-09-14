import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { alcance } from "@/lib/juridico/despacho";
import { frase, leerBitacora } from "@/lib/juridico/bitacora";

// GET /api/juridico/casos/[id]/bitacora — quién hizo qué y cuándo, lo nuevo
// primero. Sólo lectura: la bitácora no se edita ni se borra.
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const { id } = await params;
  if (!(await prisma.juridicoCaso.findFirst({ where: { id, ...(await alcance(userId)) }, select: { id: true } }))) {
    return NextResponse.json({ error: "Caso no encontrado" }, { status: 404 });
  }
  const url = new URL(req.url);
  const antes = url.searchParams.get("antesDe");
  const entradas = await leerBitacora(id, {
    limite: Number(url.searchParams.get("limite") ?? "100") || 100,
    antesDe: antes ? new Date(antes) : undefined,
    entidad: url.searchParams.get("entidad") ?? undefined,
    entidadId: url.searchParams.get("entidadId") ?? undefined,
  });
  const ids = [...new Set(entradas.map((e) => e.actorUserId).filter((v): v is string => !!v))];
  const nombres = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name ?? u.email ?? null]));
  return NextResponse.json({
    entradas: entradas.map((e) => ({ ...e, actorNombreResuelto: e.actorNombre ?? nombres.get(e.actorUserId ?? "") ?? null, frase: frase(e, nombres.get(e.actorUserId ?? "") ?? null) })),
  });
}
