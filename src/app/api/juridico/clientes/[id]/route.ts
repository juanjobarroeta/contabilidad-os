import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { actualizarCliente, obtenerCliente } from "@/lib/juridico/clientes";

// GET /api/juridico/clientes/[id] — la ficha y en qué casos aparece.
// PATCH — editarla.
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const { id } = await params;
  const cliente = await obtenerCliente(id, userId);
  if (!cliente) return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
  const [casos, partes] = await Promise.all([
    prisma.juridicoCaso.findMany({ where: { clienteId: id, userId }, orderBy: { updatedAt: "desc" }, select: { id: true, titulo: true, estado: true, updatedAt: true } }),
    prisma.juridicoParte.findMany({ where: { clienteId: id }, select: { id: true, rol: true, casoId: true, caso: { select: { titulo: true } } } }),
  ]);
  return NextResponse.json({ ...cliente, casos, papeles: partes.map((p) => ({ parteId: p.id, rol: p.rol, casoId: p.casoId, casoTitulo: p.caso.titulo })) });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const campos = ["nombre", "rfc", "curp", "domicilio", "representante", "email", "telefono", "notas"] as const;
  const cambios: Record<string, unknown> = {};
  for (const k of campos) if (k in body) cambios[k] = typeof body[k] === "string" ? body[k] : null;
  if (body.tipoPersona === "moral" || body.tipoPersona === "fisica") cambios.tipoPersona = body.tipoPersona;
  if (typeof body.verificado === "boolean") cambios.verificado = body.verificado;
  try {
    const c = await actualizarCliente(id, userId, cambios as Parameters<typeof actualizarCliente>[2], { userId }, typeof body.casoId === "string" ? body.casoId : null);
    return NextResponse.json(c);
  } catch (e) {
    return respuestaDeError(e);
  }
}
