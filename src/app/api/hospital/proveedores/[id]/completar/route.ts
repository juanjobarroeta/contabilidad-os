/**
 * POST /api/hospital/proveedores/[id]/completar
 *      { companyId, clabe?, banco?, titularCuenta?, tieneCredito?, diasCredito? }
 *      → { guardados: ["cuenta"|"credito"], omitidos: [...] }
 *
 * Lo que compras capturó al cotizar llena lo que le FALTA al proveedor (sin
 * CLABE, sin condiciones de crédito). No sobrescribe nada, por eso basta con
 * ver compras/requisiciones (la rejilla de /proveedores) y no exige
 * FINANZAS_ESCRIBIR; cambiar datos ya registrados sigue en PUT /proveedores/[id].
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { completarProveedor, completarSchema, enmascararClabe } from "@/lib/hospital/proveedores";

type Ctx = { params: Promise<{ id: string }> };

const schema = completarSchema.extend({ companyId: z.string().min(1) });

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const { companyId, ...d } = parsed.data;
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);

  const r = await completarProveedor(prisma, companyId, id, d);
  if (!r) return error("Proveedor no encontrado", 404);
  if (r.guardados.length) {
    bitacora(user, req, {
      companyId,
      accion: "hospital.proveedor.completar",
      entidad: "Supplier",
      entidadId: id,
      detalle: { ...r, ...(r.guardados.includes("cuenta") ? { clabeNueva: enmascararClabe(d.clabe ?? null) } : {}), ...(r.guardados.includes("credito") ? { tieneCredito: d.tieneCredito, diasCredito: d.diasCredito ?? null } : {}) },
    });
  }
  return NextResponse.json(r);
});
