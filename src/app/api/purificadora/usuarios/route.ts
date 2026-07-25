import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

// GET /api/purificadora/usuarios?companyId=xxx
// Miembros de la empresa con su rol y restricción de módulos. Sólo OWNER/ADMIN.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "PURIFICADORA", req);

  const members = await prisma.companyMember.findMany({
    where: { companyId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(
    members.map((m) => {
      // Sólo puede usar el módulo PURIFICADORA: el satélite lo encajona
      // según su puesto (ventanilla, reparto o ambos).
      const restringido =
        m.role === "ACCOUNTANT" &&
        m.allowedModules.length > 0 &&
        m.allowedModules.every((mod) => mod === "PURIFICADORA");
      return {
        membershipId: m.id,
        userId: m.user.id,
        nombre: m.user.name,
        email: m.user.email,
        role: m.role,
        allowedModules: m.allowedModules,
        soloVentanilla: restringido,
        puesto: restringido ? m.purifPuesto ?? "AMBOS" : null,
        createdAt: m.createdAt,
      };
    })
  );
});

const createSchema = z.object({
  companyId: z.string().min(1),
  nombre: z.string().trim().min(1).max(120),
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8, "Mínimo 8 caracteres").max(200),
  // Puesto del empleado restringido; null = acceso completo al módulo.
  // soloVentanilla (boolean) se acepta por compatibilidad → VENTANILLA.
  puesto: z.enum(["VENTANILLA", "REPARTO", "AMBOS"]).nullish(),
  soloVentanilla: z.boolean().optional(),
});

// POST /api/purificadora/usuarios — crea un usuario-empleado y su membresía
// en un paso (patrón de scripts/invite-restricted-user.mjs, vía API):
//   - User con subscriptionStatus ACTIVE (los empleados no llevan trial).
//   - CompanyMember rol ACCOUNTANT (puede escribir: tickets, cortes).
//   - soloVentanilla → allowedModules = [PURIFICADORA]: no puede entrar a la
//     UI de contabilidadOS (requiere CONTABILIDAD) ni usar otros módulos; el
//     satélite además lo encajona en la página Ventanilla.
// Sólo OWNER/ADMIN de la empresa.
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Datos inválidos";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const { companyId, nombre, email, password } = parsed.data;
  const puesto =
    parsed.data.puesto ?? (parsed.data.soloVentanilla ? ("VENTANILLA" as const) : null);

  const { user: actor } = await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "PURIFICADORA", req);

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return NextResponse.json(
      {
        error:
          "Ya existe una cuenta con ese correo. Invítala desde contabilidadOS (Configuración → Usuarios) en lugar de crearla aquí.",
      },
      { status: 409 }
    );
  }

  const hashed = await bcrypt.hash(password, 10);
  const member = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: nombre,
        email,
        password: hashed,
        subscriptionStatus: "ACTIVE", // empleado: sin reloj de trial
      },
      select: { id: true, name: true, email: true },
    });
    return tx.companyMember.create({
      data: {
        userId: user.id,
        companyId,
        role: "ACCOUNTANT",
        allowedModules: puesto ? ["PURIFICADORA"] : [],
        purifPuesto: puesto,
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  });

  registrarBitacora({
    companyId,
    userId: actor.id,
    actorEmail: actor.email,
    accion: "usuario.crear",
    entidad: "CompanyMember",
    entidadId: member.id,
    detalle: { email, role: "ACCOUNTANT", puesto, origen: "purificadora" },
  });

  return NextResponse.json(
    {
      membershipId: member.id,
      userId: member.user.id,
      nombre: member.user.name,
      email: member.user.email,
      role: member.role,
      allowedModules: member.allowedModules,
      soloVentanilla: !!puesto,
      puesto,
    },
    { status: 201 }
  );
});
