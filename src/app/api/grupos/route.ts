import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/grupos — grupos del despacho del usuario, con conteo de empresas.
// POST /api/grupos { nombre } — crea un grupo en el despacho del usuario.
// Un grupo es un sub-conjunto de empresas del mismo dueño que se facturan
// entre sí (base de la detección intercompañía y de comisiones/materialidad).

async function despachoIdDe(userId: string): Promise<string | null> {
  const m = await prisma.despachoMember.findFirst({
    where: { userId },
    select: { despachoId: true },
  });
  return m?.despachoId ?? null;
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const despachoId = await despachoIdDe(session.user.id);
  if (!despachoId) return NextResponse.json({ grupos: [] });

  const grupos = await prisma.grupo.findMany({
    where: { despachoId },
    orderBy: { nombre: "asc" },
    select: {
      id: true,
      nombre: true,
      _count: { select: { companies: true } },
      companies: { select: { id: true, rfc: true, razonSocial: true } },
    },
  });
  return NextResponse.json({ grupos });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const despachoId = await despachoIdDe(session.user.id);
  if (!despachoId) {
    return NextResponse.json({ error: "Necesitas un despacho para crear grupos" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const nombre = typeof body.nombre === "string" ? body.nombre.trim() : "";
  if (!nombre) return NextResponse.json({ error: "Nombre requerido" }, { status: 400 });

  const grupo = await prisma.grupo.create({ data: { despachoId, nombre } });
  return NextResponse.json(grupo, { status: 201 });
}
