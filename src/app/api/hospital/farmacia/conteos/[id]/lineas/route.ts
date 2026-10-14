import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error, errorZod, fechaSchema, usuarioDe } from "@/lib/hospital/http";
import { HospitalError } from "@/lib/hospital/errores";
import { contarLinea, detalleConteo } from "@/lib/hospital/conteo-db";

// ─────────────────────────────────────────────────────────────────────────────
// POST   /api/hospital/farmacia/conteos/[id]/lineas  { companyId, insumoId, lote, caducidad?, cantidad, modo?: "SUMAR" | "FIJAR" }
// DELETE /api/hospital/farmacia/conteos/[id]/lineas?companyId=&lineaId=
//
// Cada escaneo suma (SUMAR, default) o fija la cantidad final del lote (FIJAR).
// Responde el conteo completo con sus diferencias, para repintar de una.
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({
  companyId: z.string().min(1),
  insumoId: z.string().min(1),
  lote: z.string().trim().min(1).max(60),
  caducidad: fechaSchema.nullable().optional(),
  cantidad: z.number().min(0).max(10_000_000),
  modo: z.enum(["SUMAR", "FIJAR"]).optional(),
});

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;
  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  await contarLinea(prisma, {
    companyId: d.companyId, conteoId: id, insumoId: d.insumoId, lote: d.lote,
    caducidad: d.caducidad ? new Date(d.caducidad) : null, cantidad: d.cantidad, modo: d.modo ?? "SUMAR", usuarioNombre: usuarioDe(user).nombre,
  });
  return NextResponse.json({ conteo: await detalleConteo(prisma, d.companyId, id) });
});

export const DELETE = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  const lineaId = sp.get("lineaId");
  if (!companyId || !lineaId) return error("companyId y lineaId requeridos");
  await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  const c = await prisma.hospConteo.findFirst({ where: { id, companyId }, select: { estado: true } });
  if (!c) throw new HospitalError(404, "Conteo no encontrado");
  if (c.estado !== "ABIERTO") throw new HospitalError(409, "El conteo ya está cerrado");
  await prisma.hospConteoLinea.deleteMany({ where: { id: lineaId, conteoId: id } });
  return NextResponse.json({ conteo: await detalleConteo(prisma, companyId, id) });
});
