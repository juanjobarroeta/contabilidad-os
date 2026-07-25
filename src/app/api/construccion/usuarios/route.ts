import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

/**
 * Gestión de usuarios del satélite de construcción (bartiz).
 *
 * Sólo OWNER/ADMIN de la empresa. Los roles restringidos (TESORERIA /
 * RESIDENTE) nunca llegan aquí: la ruta no está en su allowlist
 * (src/lib/construccion/rol.ts).
 *
 * GET  ?companyId=  → miembros con acceso a CONSTRUCCION en la empresa
 * POST              → alta de usuario (o vincular uno existente por email)
 *                     con su rol de construcción
 */

const ROL = z.enum(["ADMIN", "TESORERIA", "RESIDENTE"]);

// Rol de construcción → MemberRole de plataforma. Los restringidos entran
// como ACCOUNTANT (pueden escribir donde su allowlist lo permita, y quedan
// fuera de las rutas OWNER/ADMIN como esta).
const MEMBER_ROLE: Record<z.infer<typeof ROL>, "ADMIN" | "ACCOUNTANT"> = {
  ADMIN: "ADMIN",
  TESORERIA: "ACCOUNTANT",
  RESIDENTE: "ACCOUNTANT",
};

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "CONSTRUCCION");

  const members = await prisma.companyMember.findMany({
    where: { companyId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      role: true,
      construccionRol: true,
      allowedModules: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });

  // Sólo los que pueden ver construcción (allowedModules vacío = todos los
  // módulos de la empresa; no-vacío = debe incluir CONSTRUCCION).
  const list = members
    .filter(
      (m) =>
        m.allowedModules.length === 0 ||
        m.allowedModules.includes("CONSTRUCCION")
    )
    .map((m) => ({
      memberId: m.id,
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      construccionRol: m.construccionRol,
      createdAt: m.createdAt,
    }));

  return NextResponse.json(list);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  name: z.string().trim().min(1, "Nombre requerido").max(120),
  email: z
    .string()
    .email("Correo inválido")
    .transform((s) => s.toLowerCase().trim()),
  // Requerida sólo si el usuario no existe aún.
  password: z.string().min(8, "Mínimo 8 caracteres").max(200).optional(),
  construccionRol: ROL,
});

export const POST = withAuthz(async (req: Request) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
      { status: 400 }
    );
  }
  const { companyId, name, email, password, construccionRol } = parsed.data;

  await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "CONSTRUCCION");

  let user = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  let created = false;

  if (!user) {
    if (!password) {
      return NextResponse.json(
        { error: "Contraseña requerida para un usuario nuevo" },
        { status: 400 }
      );
    }
    // Cuenta de empleado: ACTIVE sin trial — el login bloquea EXPIRED/
    // CANCELED y estas cuentas no deben caducar como cuentas de prueba.
    user = await prisma.user.create({
      data: {
        name,
        email,
        password: await bcrypt.hash(password, 10),
        subscriptionStatus: "ACTIVE",
      },
      select: { id: true },
    });
    created = true;
  }

  const existing = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: user.id, companyId } },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "Ese usuario ya es miembro de la empresa" },
      { status: 409 }
    );
  }

  const member = await prisma.companyMember.create({
    data: {
      userId: user.id,
      companyId,
      role: MEMBER_ROLE[construccionRol],
      construccionRol,
      // Encajonado al satélite de construcción: no ve contabilidad/nómina.
      allowedModules: ["CONSTRUCCION"],
    },
    select: {
      id: true,
      role: true,
      construccionRol: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });

  return NextResponse.json(
    {
      memberId: member.id,
      userId: member.user.id,
      name: member.user.name,
      email: member.user.email,
      role: member.role,
      construccionRol: member.construccionRol,
      created,
    },
    { status: 201 }
  );
});
