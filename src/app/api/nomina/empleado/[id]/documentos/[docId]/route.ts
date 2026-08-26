import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

type Params = { params: Promise<{ id: string; docId: string }> };

// GET    /api/nomina/empleado/[id]/documentos/[docId] — descarga el archivo
// DELETE /api/nomina/empleado/[id]/documentos/[docId] — lo elimina

export async function GET(req: Request, { params }: Params) {
  try {
    const { id, docId } = await params;
    const doc = await prisma.employeeDocumento.findUnique({ where: { id: docId } });
    if (!doc || doc.employeeId !== id) {
      return NextResponse.json({ error: "Documento no encontrado" }, { status: 404 });
    }
    await requireMembership(doc.companyId, undefined, req);

    // SIEMPRE attachment: el expediente se descarga, no se ejecuta en el
    // origen del hub. El nombre va saneado para no romper el encabezado.
    const nombre = doc.nombre.replace(/[^\w. ()-]/g, "_");
    return new NextResponse(new Uint8Array(doc.archivo), {
      headers: {
        "Content-Type": doc.mime,
        "Content-Length": String(doc.bytes),
        "Content-Disposition": `attachment; filename="${nombre}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function DELETE(req: Request, { params }: Params) {
  try {
    const { id, docId } = await params;
    const doc = await prisma.employeeDocumento.findUnique({
      where: { id: docId },
      select: { id: true, companyId: true, employeeId: true, tipo: true, nombre: true },
    });
    if (!doc || doc.employeeId !== id) {
      return NextResponse.json({ error: "Documento no encontrado" }, { status: 404 });
    }
    const { user } = await requireWriter(doc.companyId, req);

    await prisma.employeeDocumento.delete({ where: { id: docId } });

    registrarBitacora({
      companyId: doc.companyId,
      userId: user.id,
      actorEmail: user.email ?? null,
      accion: "nomina.expediente.eliminar",
      entidad: "EmployeeDocumento",
      entidadId: doc.id,
      detalle: { employeeId: id, tipo: doc.tipo, nombre: doc.nombre },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
