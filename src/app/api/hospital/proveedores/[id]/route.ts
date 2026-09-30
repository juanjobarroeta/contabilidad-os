/**
 * GET /api/hospital/proveedores/[id]   Ficha del proveedor con sus condiciones.
 * PUT /api/hospital/proveedores/[id]   { razonSocial?, regimenFiscal?, email?, clabe?, banco?, titularCuenta?, tieneCredito?, diasCredito? }
 *     El RFC no cambia (identidad fiscal: casa sus facturas). Datos de pago y
 *     crédito exigen FINANZAS_ESCRIBIR y el cambio de CLABE queda en bitácora
 *     con la anterior enmascarada.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { requireClinicalPermission } from "@/lib/hospital/permisos";
import { enmascararClabe, guardarTerminos, proveedorSchema, SELECT_PROVEEDOR, tocaDatosDePago } from "@/lib/hospital/proveedores";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const p = await prisma.supplier.findUnique({ where: { id }, select: { ...SELECT_PROVEEDOR, companyId: true } });
  if (!p) return error("Proveedor no encontrado", 404);
  await requireMembership(p.companyId, undefined, req);
  await requireModule(p.companyId, "HOSPITAL", req);
  return NextResponse.json(p);
});

export const PUT = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = proveedorSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const actual = await prisma.supplier.findUnique({ where: { id }, select: { companyId: true, rfc: true, clabe: true } });
  if (!actual) return error("Proveedor no encontrado", 404);
  const { user } = await requireWriter(actual.companyId, req);
  await requireModule(actual.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const { companyId: _c, rfc, tieneCredito, diasCredito, ...d } = parsed.data;
  void _c;
  if (rfc && rfc !== actual.rfc) return error("El RFC no se cambia: da de alta otro proveedor", 409);
  if (tocaDatosDePago(parsed.data)) await requireClinicalPermission(actual.companyId, user.id, "FINANZAS_ESCRIBIR");

  const p = await prisma.$transaction(async (tx) => {
    await tx.supplier.update({
      where: { id },
      data: {
        ...(d.razonSocial !== undefined && { razonSocial: d.razonSocial }),
        ...(d.regimenFiscal !== undefined && { regimenFiscal: d.regimenFiscal }),
        ...(d.email !== undefined && { email: d.email }),
        ...(d.clabe !== undefined && { clabe: d.clabe }),
        ...(d.banco !== undefined && { banco: d.banco }),
        ...(d.titularCuenta !== undefined && { titularCuenta: d.titularCuenta }),
      },
    });
    if (tieneCredito !== undefined) await guardarTerminos(tx, id, tieneCredito, diasCredito);
    return tx.supplier.findUniqueOrThrow({ where: { id }, select: SELECT_PROVEEDOR });
  });
  const cambioClabe = d.clabe !== undefined && d.clabe !== actual.clabe;
  bitacora(user, req, {
    companyId: actual.companyId,
    accion: cambioClabe ? "hospital.proveedor.cambio-clabe" : "hospital.proveedor.editar",
    entidad: "Supplier",
    entidadId: id,
    detalle: { campos: Object.keys(parsed.data), ...(cambioClabe ? { clabeAnterior: enmascararClabe(actual.clabe), clabeNueva: enmascararClabe(d.clabe ?? null) } : {}) },
  });
  return NextResponse.json(p);
});
