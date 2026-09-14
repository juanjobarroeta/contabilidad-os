import { NextResponse } from "next/server";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { conteoPorEstado, crearCaso, esEstadoCaso, listarCasos } from "@/lib/juridico/casos";

// GET /api/juridico/casos?estado=&q= — la lista del despacho, con conteos.
// POST — abre un caso.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const url = new URL(req.url);
  const estado = url.searchParams.get("estado");
  const [casos, conteos] = await Promise.all([
    listarCasos(userId, { estado: esEstadoCaso(estado) ? estado : undefined, busqueda: url.searchParams.get("q") ?? undefined, limite: Number(url.searchParams.get("limite") ?? "50") || 50 }),
    conteoPorEstado(userId),
  ]);
  return NextResponse.json({ casos, conteos });
}

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (k: string) => (typeof body[k] === "string" && body[k] ? (body[k] as string) : null);
  if (!str("titulo")) return NextResponse.json({ error: "El caso necesita un título." }, { status: 400 });
  try {
    const c = await crearCaso(
      userId,
      { titulo: str("titulo")!, materia: str("materia"), via: str("via"), autoridad: str("autoridad"), expediente: str("expediente"), entidad: str("entidad"), cliente: str("cliente"), clienteId: str("clienteId"), objetivo: str("objetivo") },
      { userId }
    );
    return NextResponse.json(c, { status: 201 });
  } catch (e) {
    return respuestaDeError(e);
  }
}
