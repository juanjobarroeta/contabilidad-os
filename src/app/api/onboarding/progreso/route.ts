import { NextResponse } from "next/server";
import { AuthzError, requireUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { mezclarProgreso, sanearProgreso } from "@/lib/onboarding/progreso";

// GET/PATCH /api/onboarding/progreso — en qué pantalla del alta va el usuario
// (User.onboarding). Recargar /onboarding retoma desde aquí.

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const u = await prisma.user.findUnique({ where: { id: user.id }, select: { onboarding: true } });
    return NextResponse.json({ progreso: u?.onboarding ? sanearProgreso(u.onboarding) : null });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });
    const u = await prisma.user.findUnique({ where: { id: user.id }, select: { onboarding: true } });
    const actual = sanearProgreso(u?.onboarding);
    const cambio = sanearProgreso({ ...actual, ...body });
    // La empresa del alta tiene que ser del usuario: no se guarda un id ajeno.
    if (cambio.companyId && cambio.companyId !== actual.companyId) {
      const miembro = await prisma.companyMember.findFirst({ where: { userId: user.id, companyId: cambio.companyId }, select: { id: true } });
      if (!miembro) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });
    }
    const siguiente = mezclarProgreso(actual, cambio, { permitirRetroceso: body.reiniciar === true });
    await prisma.user.update({ where: { id: user.id }, data: { onboarding: { ...siguiente } } });
    return NextResponse.json({ progreso: siguiente });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
