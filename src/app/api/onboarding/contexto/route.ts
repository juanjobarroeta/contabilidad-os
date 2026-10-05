import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { accessibleCompaniesWhere } from "@/lib/companies/accessible";

// GET /api/onboarding/contexto — le dice al wizard de onboarding si el usuario
// llegó por una INVITACIÓN (su despacho nació con condiciones predefinidas):
// en ese caso el paso "Plan" no debe vender precios — el plan ya está incluido.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const dm = await prisma.despachoMember.findUnique({
    where: { userId: session.user.id },
    select: {
      role: true,
      despacho: { select: { name: true, defaultTier: true, maxEmpresas: true } },
    },
  });
  // Empresas a las que ya entra: con alguna, /onboarding es «agregar otra»
  // (sin bienvenida ni recorrido).
  const accesibles = await accessibleCompaniesWhere(session.user.id);
  const empresas = await prisma.company.count({ where: accesibles });
  // Alta cortada a medias: la empresa se creó hace minutos pero el avance no
  // alcanzó a ligarla (recarga en plena creación). El wizard la retoma en
  // «historial» en vez de mandar al usuario a «agregar otra» y pedirle la
  // e.firma de nuevo.
  const empresaReciente = await prisma.company.findFirst({
    where: { AND: [accesibles, { createdAt: { gte: new Date(Date.now() - 30 * 60_000) } }] },
    orderBy: { createdAt: "desc" },
    select: { id: true, razonSocial: true },
  });
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { subscriptionStatus: true },
  });

  // defaultTier != null ⇔ el despacho lo creó una invitación de onboarding.
  const invitado = dm?.despacho?.defaultTier != null;
  return NextResponse.json({
    invitado,
    despachoNombre: dm?.despacho?.name ?? null,
    sinCargo: invitado && user?.subscriptionStatus === "ACTIVE",
    syntage: invitado ? dm!.despacho!.defaultTier !== "ASISTENTE" : null,
    maxEmpresas: dm?.despacho?.maxEmpresas ?? null,
    despachoRol: dm?.role ?? null,
    empresas,
    empresaReciente,
  });
}
