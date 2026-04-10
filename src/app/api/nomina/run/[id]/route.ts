import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

type Params = { params: Promise<{ id: string }> };

// GET /api/nomina/run/[id]
export async function GET(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const run = await prisma.payrollRun.findUnique({
    where: { id },
    include: {
      items: {
        include: { employee: { select: { nombre: true, apellidoPaterno: true, rfc: true } } },
      },
    },
  });

  if (!run) return NextResponse.json({ error: "Corrida no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, run.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  return NextResponse.json(run);
}
