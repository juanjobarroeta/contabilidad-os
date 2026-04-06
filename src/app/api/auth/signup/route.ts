import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const signupSchema = z.object({
  name: z.string().trim().min(1, "Nombre requerido").max(120),
  email: z.string().email("Correo inválido").transform((s) => s.toLowerCase().trim()),
  password: z.string().min(8, "Mínimo 8 caracteres").max(200),
});

const TRIAL_DAYS = 15;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Datos inválidos";
    return NextResponse.json({ error: first }, { status: 400 });
  }

  const { name, email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "Ya existe una cuenta con este correo" },
      { status: 409 }
    );
  }

  const hashed = await bcrypt.hash(password, 10);
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);

  const user = await prisma.user.create({
    data: {
      name,
      email,
      password: hashed,
      subscriptionStatus: "TRIALING",
      trialEndsAt,
    },
    select: { id: true, email: true, name: true, trialEndsAt: true },
  });

  return NextResponse.json(user, { status: 201 });
}
