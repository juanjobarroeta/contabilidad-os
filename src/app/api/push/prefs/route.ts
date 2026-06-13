import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Preferencias de notificación por categoría (modelo opt-out: true por defecto).
const CATEGORIAS = ["cfdis", "declaraciones"] as const;
type Categoria = (typeof CATEGORIAS)[number];

function normaliza(prefs: unknown): Record<Categoria, boolean> {
  const p = (prefs ?? {}) as Record<string, boolean>;
  return {
    cfdis: p.cfdis !== false,
    declaraciones: p.declaraciones !== false,
  };
}

// GET /api/push/prefs → { cfdis, declaraciones } (default true)
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const u = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { notifPrefs: true },
  });
  return NextResponse.json(normaliza(u?.notifPrefs));
}

// PUT /api/push/prefs  body: { cfdis?, declaraciones? } → merge
export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as Partial<Record<Categoria, boolean>>;
  const u = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { notifPrefs: true },
  });
  const current = normaliza(u?.notifPrefs);
  for (const c of CATEGORIAS) {
    if (typeof body[c] === "boolean") current[c] = body[c] as boolean;
  }

  await prisma.user.update({
    where: { id: session.user.id },
    data: { notifPrefs: current },
  });
  return NextResponse.json(current);
}
