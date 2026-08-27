import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { withAuthz } from "@/lib/authz";
import { requireAutoPortalAccount } from "@/lib/automotriz/portal";
import { checkRateLimit } from "@/lib/rate-limit";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/automotriz/portal/citas — el cliente agenda su servicio desde
// el portal y ve sus citas. Todo acotado al customerId del token (nunca
// requireMembership aquí). La cita incluye la orden que la cumplió (folio +
// estado): es la ventana del cliente al avance de su unidad — sin montos.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ABIERTAS = 3;

export const GET = withAuthz(async (req: Request) => {
  const ctx = await requireAutoPortalAccount(req);
  const citas = await prisma.citaServicio.findMany({
    where: { companyId: ctx.companyId, customerId: ctx.customerId },
    select: {
      id: true, estado: true, canal: true, fecha: true, motivo: true, createdAt: true,
      vin: true, descripcionUnidad: true,
      vehiculo: { select: { vin: true, marca: true, modelo: true, anio: true } },
      orden: { select: { folio: true, estado: true } },
    },
    orderBy: { fecha: "desc" },
    take: 50,
  });
  return NextResponse.json({ citas });
});

const createSchema = z.object({
  vehiculoId: z.string().nullable().optional(),
  vin: z.string().max(17).nullable().optional(),
  descripcionUnidad: z.string().max(200).nullable().optional(),
  fecha: z.string().datetime(),
  motivo: z.string().min(5).max(2000),
});

export const POST = withAuthz(async (req: Request) => {
  const ctx = await requireAutoPortalAccount(req);

  const rl = checkRateLimit(`auto-portal:citas:${ctx.accountId}`, { limit: 5, windowMs: 60 * 60 * 1000 });
  if (!rl.ok) return NextResponse.json({ error: "Demasiadas solicitudes, intenta más tarde" }, { status: 429 });

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  const fecha = new Date(d.fecha);
  if (!(fecha > new Date())) {
    return NextResponse.json({ error: "La fecha de la cita debe ser futura" }, { status: 400 });
  }

  // Sólo SUS unidades — y sin confirmar la existencia de las ajenas.
  let vehiculo: { vin: string | null; marca: string | null; modelo: string | null; anio: number | null } | null = null;
  if (d.vehiculoId) {
    const v = await prisma.vehiculo.findUnique({
      where: { id: d.vehiculoId },
      select: { companyId: true, clienteId: true, vin: true, marca: true, modelo: true, anio: true },
    });
    if (!v || v.companyId !== ctx.companyId || v.clienteId !== ctx.customerId) {
      return NextResponse.json({ error: "Unidad no encontrada" }, { status: 404 });
    }
    vehiculo = v;
  }

  const abiertas = await prisma.citaServicio.count({
    where: { companyId: ctx.companyId, customerId: ctx.customerId, estado: { in: ["PENDIENTE", "CONFIRMADA"] } },
  });
  if (abiertas >= MAX_ABIERTAS) {
    return NextResponse.json(
      { error: `Ya tienes ${abiertas} citas abiertas; cancela una o espera a que el taller la reciba` },
      { status: 422 }
    );
  }

  const cita = await prisma.citaServicio.create({
    data: {
      companyId: ctx.companyId,
      customerId: ctx.customerId,
      canal: "PORTAL",
      estado: "PENDIENTE",
      vehiculoId: d.vehiculoId ?? null,
      vin: (d.vin ?? vehiculo?.vin)?.trim().toUpperCase() || null,
      descripcionUnidad:
        d.descripcionUnidad ??
        (vehiculo ? `${vehiculo.marca ?? ""} ${vehiculo.modelo ?? ""} ${vehiculo.anio ?? ""}`.trim() || null : null),
      fecha,
      motivo: d.motivo,
    },
    select: { id: true, estado: true, fecha: true, motivo: true, descripcionUnidad: true },
  });

  registrarBitacora({
    companyId: ctx.companyId,
    actorEmail: ctx.email,
    accion: "automotriz.portal.cita.crear",
    entidad: "CitaServicio",
    entidadId: cita.id,
    detalle: { fecha: d.fecha, motivo: d.motivo.slice(0, 120) },
  });
  return NextResponse.json(cita, { status: 201 });
});
