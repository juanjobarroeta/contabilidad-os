import { NextResponse } from "next/server";
import { AuthzError, requireUser } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { mezclarProgreso, PASOS_AGREGAR, sanearAgregar, sanearProgreso } from "@/lib/onboarding/progreso";
import { accessibleCompaniesWhere } from "@/lib/companies/accessible";

function registro(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

// GET/PATCH /api/onboarding/progreso — en qué pantalla del alta va el usuario
// (User.onboarding). Recargar /onboarding retoma desde aquí.

export async function GET(req: Request) {
  try {
    const user = await requireUser(req);
    const u = await prisma.user.findUnique({ where: { id: user.id }, select: { onboarding: true } });
    return NextResponse.json({
      progreso: u?.onboarding ? sanearProgreso(u.onboarding) : null,
      agregar: sanearAgregar(registro(u?.onboarding).agregar),
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function PATCH(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Cuerpo inválido" }, { status: 400 });
    if (body.flujo !== undefined && body.flujo !== "alta" && body.flujo !== "agregar") return NextResponse.json({ error: "Flujo inválido" }, { status: 400 });
    const result = await prisma.$transaction(async (tx) => {
      // Lock before reading: concurrent partial saves must merge against the
      // latest committed JSON, never overwrite another request's fields.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${user.id} FOR UPDATE`;
      const u = await tx.user.findUniqueOrThrow({ where: { id: user.id }, select: { onboarding: true } });
      const raw = registro(u.onboarding);
      const actual = sanearProgreso(raw);
      const agregarActual = sanearAgregar(raw.agregar);
      const adding = body.flujo === "agregar";
      const siguiente = adding ? actual : mezclarProgreso(actual, body, { permitirRetroceso: body.reiniciar === true });
      let agregar = agregarActual;
      if (adding) {
        agregar = sanearAgregar({ ...(body.reiniciar === true ? {} : agregarActual), ...body })!;
        if (body.reiniciar !== true && agregarActual && PASOS_AGREGAR.indexOf(agregar.paso) < PASOS_AGREGAR.indexOf(agregarActual.paso)) agregar.paso = agregarActual.paso;
      }
      const companyId = adding ? agregar?.companyId : siguiente.companyId;
      if (companyId) {
        const where = await accessibleCompaniesWhere(user.id, tx);
        if (!await tx.company.count({ where: { AND: [where, { id: companyId }] } })) throw new AuthzError(404, "Empresa no encontrada");
      }
      await tx.user.update({ where: { id: user.id }, data: { onboarding: { ...siguiente, ...(agregar ? { agregar: { ...agregar } } : {}) } } });
      return { progreso: siguiente, agregar };
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
