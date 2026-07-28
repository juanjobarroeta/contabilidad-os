import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { esAdminPlataforma } from "@/lib/billing/admin-plataforma";
import { appBaseUrl } from "@/lib/billing/stripe";
import {
  mintOnboardingToken,
  onboardingInviteExpiry,
} from "@/lib/onboarding-invite";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// Invitaciones de onboarding — SÓLO admin de plataforma (PLATFORM_ADMIN_EMAILS).
//
// POST  crea una invitación con condiciones predefinidas (cortesía + tier con
//       Syntage) y devuelve el ENLACE y el CÓDIGO (el token crudo, una sola vez).
// GET   lista las invitaciones (sin el token crudo — sólo su estado).
// ─────────────────────────────────────────────────────────────────────────────

const TIERS = ["ASISTENTE", "AUTOMATIZADO", "PRO", "DESPACHO"] as const;

const createSchema = z.object({
  despachoName: z.string().trim().min(2).max(120),
  ownerNombre: z.string().trim().max(120).optional().or(z.literal("")),
  tierEmpresas: z.enum(TIERS).default("AUTOMATIZADO"),
  sinCargo: z.boolean().default(true),
  trialDays: z.number().int().min(1).max(90).default(15),
  /// Tope de empresas del despacho invitado. Ausente/null = sin límite.
  maxEmpresas: z.number().int().min(1).max(100).nullable().optional(),
});

async function requireAdmin() {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email || !esAdminPlataforma(email)) return null;
  return { email };
}

function linkYCodigo(rawToken: string): { link: string; codigo: string } {
  return { link: `${appBaseUrl()}/signup?invite=${rawToken}`, codigo: rawToken };
}

export async function POST(req: Request) {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Sólo el admin de plataforma" }, { status: 403 });

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Datos inválidos" }, { status: 400 });
  }
  const d = parsed.data;

  const { rawToken, tokenHash } = mintOnboardingToken();
  const invite = await prisma.onboardingInvite.create({
    data: {
      createdByEmail: admin.email,
      despachoName: d.despachoName,
      ownerNombre: d.ownerNombre || null,
      tierEmpresas: d.tierEmpresas,
      sinCargo: d.sinCargo,
      trialDays: d.trialDays,
      maxEmpresas: d.maxEmpresas ?? null,
      tokenHash,
      expiresAt: onboardingInviteExpiry(),
    },
    select: { id: true, despachoName: true, expiresAt: true },
  });

  registrarBitacora({
    companyId: null,
    userId: null,
    actorEmail: admin.email,
    accion: "onboarding-invite.crear",
    entidad: "OnboardingInvite",
    entidadId: invite.id,
    detalle: { despachoName: d.despachoName, tierEmpresas: d.tierEmpresas, sinCargo: d.sinCargo, maxEmpresas: d.maxEmpresas ?? null },
    req,
  });

  // El token crudo se entrega AQUÍ y sólo aquí.
  return NextResponse.json({ ...invite, ...linkYCodigo(rawToken) }, { status: 201 });
}

export async function GET() {
  const admin = await requireAdmin();
  if (!admin) return NextResponse.json({ error: "Sólo el admin de plataforma" }, { status: 403 });

  const invites = await prisma.onboardingInvite.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true, despachoName: true, ownerNombre: true, tierEmpresas: true,
      sinCargo: true, trialDays: true, maxEmpresas: true, status: true, expiresAt: true,
      acceptedByEmail: true, acceptedAt: true, createdAt: true,
    },
  });
  return NextResponse.json(invites);
}
