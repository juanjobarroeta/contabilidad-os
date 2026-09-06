import { NextResponse } from "next/server";
import type { CompanyPlan } from "@prisma/client";
import { auth } from "@/lib/auth";
import { isOperador } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { registrarBitacora } from "@/lib/audit";
import { PLAN_LABEL } from "@/lib/planes";

// ─────────────────────────────────────────────────────────────────────────────
// GET  /api/operador/tiers                → despachos con sus empresas y tier.
// POST /api/operador/tiers { tier, despachoId } | { tier, companyIds[] }
//
// El panel de operador para tiers que scripts/set-tier.mjs decía que no
// existía. Mismo efecto que el script (idempotente, imprime antes/después),
// sin necesitar la URL de la base en una terminal. Sólo operador de
// plataforma; cada cambio queda en bitácora con el tier anterior.
//
// OJO: subir a AUTOMATIZADO+ enciende Syntage (el cron aprovisiona y las
// extracciones cuestan); PRO/DESPACHO además banco (Belvo), WhatsApp y el
// cierre guiado. Ver src/lib/planes.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

const TIERS: CompanyPlan[] = ["ASISTENTE", "AUTOMATIZADO", "PRO", "DESPACHO"];

async function operador(): Promise<{ id: string; email: string | null } | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  if (!(await isOperador(session.user.id))) return null;
  return { id: session.user.id, email: session.user.email ?? null };
}

export async function GET() {
  const op = await operador();
  if (!op) return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });

  const despachos = await prisma.despacho.findMany({
    select: {
      id: true,
      name: true,
      defaultTier: true,
      companies: {
        where: { isActive: true },
        select: { id: true, rfc: true, razonSocial: true, tier: true },
        orderBy: { razonSocial: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });
  const sinDespacho = await prisma.company.findMany({
    where: { isActive: true, despachoId: null },
    select: { id: true, rfc: true, razonSocial: true, tier: true },
    orderBy: { razonSocial: "asc" },
  });
  return NextResponse.json({
    tiers: TIERS.map((t) => ({ valor: t, label: PLAN_LABEL[t] })),
    despachos: despachos.map((d) => ({
      id: d.id,
      nombre: d.name,
      defaultTier: d.defaultTier,
      empresas: d.companies,
    })),
    sinDespacho,
  });
}

export async function POST(req: Request) {
  const op = await operador();
  if (!op) return NextResponse.json({ error: "Sólo disponible para operador de plataforma" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as
    | { tier?: string; despachoId?: string; companyIds?: unknown }
    | null;
  const tier = String(body?.tier ?? "").toUpperCase() as CompanyPlan;
  if (!TIERS.includes(tier)) {
    return NextResponse.json({ error: `tier inválido; usa ${TIERS.join(" | ")}` }, { status: 400 });
  }
  const companyIds = Array.isArray(body?.companyIds)
    ? body!.companyIds.filter((x): x is string => typeof x === "string")
    : [];
  const despachoId = typeof body?.despachoId === "string" ? body.despachoId : null;
  if (!despachoId && companyIds.length === 0) {
    return NextResponse.json({ error: "despachoId o companyIds requeridos" }, { status: 400 });
  }

  const empresas = await prisma.company.findMany({
    where: despachoId ? { despachoId, isActive: true } : { id: { in: companyIds } },
    select: { id: true, rfc: true, razonSocial: true, tier: true },
    orderBy: { razonSocial: "asc" },
  });
  if (empresas.length === 0) {
    return NextResponse.json({ error: "No hay empresas que cambiar" }, { status: 404 });
  }

  const cambiadas: { id: string; rfc: string; razonSocial: string; antes: CompanyPlan; despues: CompanyPlan }[] = [];
  const sinCambio: { id: string; rfc: string; razonSocial: string; tier: CompanyPlan }[] = [];
  for (const c of empresas) {
    if (c.tier === tier) {
      sinCambio.push(c);
      continue;
    }
    await prisma.company.update({ where: { id: c.id }, data: { tier } });
    cambiadas.push({ id: c.id, rfc: c.rfc, razonSocial: c.razonSocial, antes: c.tier, despues: tier });
    registrarBitacora({
      companyId: c.id,
      userId: op.id,
      actorEmail: op.email,
      accion: "operador.tier.cambiar",
      entidad: "Company",
      entidadId: c.id,
      detalle: { rfc: c.rfc, antes: c.tier, despues: tier, despachoId },
      req,
    });
  }
  return NextResponse.json({ ok: true, tier, cambiadas, sinCambio });
}
