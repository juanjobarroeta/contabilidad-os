import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { leerVersion, listarVersiones } from "@/lib/juridico/versiones";

// GET /api/juridico/documentos/[id]/versiones — el historial con autor y qué
// cambió; con ?n=3 devuelve el texto de esa versión (para comparar).
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const { id } = await params;
  const doc = await prisma.juridicoDocumento.findFirst({ where: { id, userId }, select: { id: true, nombre: true, texto: true, estado: true } });
  if (!doc) return NextResponse.json({ error: "Documento no encontrado" }, { status: 404 });
  const url = new URL(req.url);
  const n = Number(url.searchParams.get("n") ?? "");
  if (Number.isInteger(n) && n > 0) {
    const v = await leerVersion(id, n);
    if (!v) return NextResponse.json({ error: "Versión no encontrada" }, { status: 404 });
    return NextResponse.json({ n, ...v });
  }
  const versiones = await listarVersiones(id);
  const ids = [...new Set(versiones.map((v) => v.autorUserId).filter((x): x is string => !!x))];
  const nombres = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u.name ?? u.email ?? null]));
  return NextResponse.json({
    documento: { id: doc.id, nombre: doc.nombre, estado: doc.estado, caracteres: doc.texto.length },
    versiones: versiones.map((v) => ({ ...v, autorNombreResuelto: v.autorNombre ?? nombres.get(v.autorUserId ?? "") ?? null })),
  });
}
