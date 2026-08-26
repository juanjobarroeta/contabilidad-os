import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

// GET /api/automotriz/usuarios?companyId=xxx
// Miembros de la empresa con su rol y las PÁGINAS del satélite que pueden ver
// (la rejilla de permisos de AutomotrizPro). Sólo OWNER/ADMIN.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const members = await prisma.companyMember.findMany({
    where: { companyId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json(
    members.map((m) => ({
      membershipId: m.id,
      userId: m.user.id,
      nombre: m.user.name,
      email: m.user.email,
      role: m.role,
      // Vacío = ve TODAS las páginas del satélite (default compatible).
      paginas: m.automotrizPaginas,
      sinRestriccion: m.automotrizPaginas.length === 0,
      createdAt: m.createdAt,
    }))
  );
});

const createSchema = z.object({
  companyId: z.string().min(1),
  nombre: z.string().trim().min(1).max(120),
  email: z.string().email().transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8, "Mínimo 8 caracteres").max(200),
  // ACCOUNTANT escribe (órdenes, corridas); VIEWER sólo lee.
  role: z.enum(["ACCOUNTANT", "VIEWER"]).default("ACCOUNTANT"),
  // Llaves de página del satélite; [] = todas. Strings opacos para el hub.
  paginas: z.array(z.string().trim().min(1).max(40)).max(64).default([]),
});

// POST /api/automotriz/usuarios — crea un usuario-empleado y su membresía en
// un paso (mismo patrón que purificadora/usuarios):
//   - User con subscriptionStatus ACTIVE (los empleados no llevan trial).
//   - CompanyMember encajonado al módulo AUTOMOTRIZ (no puede entrar a la UI
//     de contabilidadOS) y a las páginas elegidas en la rejilla.
// Sólo OWNER/ADMIN de la empresa.
export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Datos inválidos";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const { companyId, nombre, email, password, role, paginas } = parsed.data;

  const { user: actor } = await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

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
        role,
        allowedModules: ["AUTOMOTRIZ"],
        automotrizPaginas: paginas,
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
    detalle: { email, role, paginas, origen: "automotriz" },
  });

  return NextResponse.json(
    {
      membershipId: member.id,
      userId: member.user.id,
      nombre: member.user.name,
      email: member.user.email,
      role: member.role,
      paginas: member.automotrizPaginas,
      sinRestriccion: member.automotrizPaginas.length === 0,
    },
    { status: 201 }
  );
});
