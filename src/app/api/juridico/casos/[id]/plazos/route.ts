import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { alcance, despachoDe } from "@/lib/juridico/despacho";
import { crearPlazo, esFuero, esSurte, esTipoDias, listarPlazos, simular } from "@/lib/juridico/plazos-datos";

// GET  /api/juridico/casos/[id]/plazos — los plazos del caso, el que vence antes primero.
// POST — proponer uno. Nace `propuesto`: hay que confirmarlo aparte.
//        Con ?simular=1 sólo computa y devuelve la traza, sin guardar nada.
export const dynamic = "force-dynamic";

async function esDelUsuario(casoId: string, userId: string) {
  return !!(await prisma.juridicoCaso.findFirst({ where: { id: casoId, ...(await alcance(userId)) }, select: { id: true } }));
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
  return NextResponse.json({ plazos: await listarPlazos(id, { incluirCerrados: url.searchParams.get("todos") === "1" }) });
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
  if (!esFuero(body.fuero)) return NextResponse.json({ error: "Falta el fuero: amparo, laboral, federal o local." }, { status: 400 });
  const datos = {
    titulo: String(body.titulo ?? ""),
    fuero: body.fuero,
    entidad: typeof body.entidad === "string" ? body.entidad : null,
    notificacion: String(body.notificacion ?? ""),
    dias: Number(body.dias),
    tipo: esTipoDias(body.tipo) ? body.tipo : undefined,
    surteEfectos: esSurte(body.surteEfectos) ? body.surteEfectos : undefined,
    fundamento: typeof body.fundamento === "string" ? body.fundamento : null,
    ordenamiento: typeof body.ordenamiento === "string" ? body.ordenamiento : null,
    articulo: typeof body.articulo === "string" ? body.articulo : null,
    nota: typeof body.nota === "string" ? body.nota : null,
  };
  const despachoId = (await despachoDe(userId))?.despachoId ?? null;
  try {
    if (new URL(req.url).searchParams.get("simular") === "1") {
      return NextResponse.json({ computo: await simular({ ...datos, despachoId }) });
    }
    return NextResponse.json({ plazo: await crearPlazo(id, userId, datos, { userId }, despachoId) }, { status: 201 });
  } catch (e) {
    return respuestaDeError(e);
  }
}
