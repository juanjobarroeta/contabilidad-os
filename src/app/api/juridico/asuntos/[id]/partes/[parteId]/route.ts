import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, puedeUsarJuridico, requireUser } from "@/lib/authz";
import { cargarAsunto, normalizarCurp, normalizarRfc } from "@/lib/juridico/asuntos";

async function autorizar(req: Request, asuntoId: string) {
  const u = await requireUser(req);
  if (!(await puedeUsarJuridico(u.id))) throw new AuthzError(403, "Tu cuenta no tiene acceso al copiloto jurídico");
  const a = await prisma.juridicoAsunto.findFirst({ where: { id: asuntoId, userId: u.id }, select: { id: true } });
  if (!a) throw new AuthzError(404, "Asunto no encontrado");
  return u.id;
}
const errorDe = (e: unknown) => NextResponse.json({ error: e instanceof AuthzError ? e.message : "Unauthorized" }, { status: e instanceof AuthzError ? e.status : 401 });

// PATCH /api/juridico/asuntos/[id]/partes/[parteId] — editar / verificar una parte (lo editado a mano queda como manual y verificado).
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; parteId: string }> }) {
  const { id, parteId } = await params;
  let userId: string;
  try {
    userId = await autorizar(req, id);
  } catch (e) {
    return errorDe(e);
  }
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string).trim().slice(0, 400) : undefined);
  const data: Record<string, unknown> = {};
  for (const k of ["rol", "nombre", "domicilio", "representante", "email", "telefono", "notas"]) if (str(k) !== undefined) data[k] = str(k);
  if (str("tipoPersona") !== undefined) data.tipoPersona = str("tipoPersona") === "moral" ? "moral" : "fisica";
  if (str("rfc") !== undefined) data.rfc = normalizarRfc(str("rfc")) ?? str("rfc") ?? null;
  if (str("curp") !== undefined) data.curp = normalizarCurp(str("curp")) ?? str("curp") ?? null;
  if (typeof b.verificado === "boolean") data.verificado = b.verificado;
  if (Object.keys(data).some((k) => k !== "verificado")) {
    data.fuente = "manual";
    data.verificado = b.verificado === false ? false : true;
  }
  const r = await prisma.juridicoParte.updateMany({ where: { id: parteId, asuntoId: id }, data });
  if (r.count === 0) return NextResponse.json({ error: "Parte no encontrada" }, { status: 404 });
  return NextResponse.json(await cargarAsunto(id, userId));
}

// DELETE /api/juridico/asuntos/[id]/partes/[parteId]
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; parteId: string }> }) {
  const { id, parteId } = await params;
  let userId: string;
  try {
    userId = await autorizar(req, id);
  } catch (e) {
    return errorDe(e);
  }
  const r = await prisma.juridicoParte.deleteMany({ where: { id: parteId, asuntoId: id } });
  if (r.count === 0) return NextResponse.json({ error: "Parte no encontrada" }, { status: 404 });
  return NextResponse.json(await cargarAsunto(id, userId));
}
