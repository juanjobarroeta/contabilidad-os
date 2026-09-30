/**
 * GET  /api/hospital/proveedores?companyId=[&q=][&conCuenta=1]
 *      Padrón de proveedores (Supplier del hub, el mismo de bancos, obra y
 *      médicos): RFC, datos de pago, condiciones de crédito y cuántas
 *      requisiciones tiene. `q` busca por razón social o RFC.
 * POST /api/hospital/proveedores { companyId, rfc, razonSocial, regimenFiscal?, email?,
 *                                  clabe?, banco?, titularCuenta?, tieneCredito?, diasCredito? }
 *      Alta (también desde una requisición). RFC con formato del SAT y único
 *      por empresa: si ya existe responde 409 con el existente para usarlo.
 *      Los datos de pago y el crédito exigen FINANZAS_ESCRIBIR: una CLABE
 *      cambiada es la puerta clásica de un fraude.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { requireClinicalPermission } from "@/lib/hospital/permisos";
import { proveedorSchema, tocaDatosDePago, guardarTerminos, SELECT_PROVEEDOR } from "@/lib/hospital/proveedores";

export const GET = withHospital(async (req: Request) => {
  const sp = new URL(req.url).searchParams;
  const companyId = sp.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  const q = sp.get("q")?.trim();
  const proveedores = await prisma.supplier.findMany({
    where: {
      companyId,
      ...(q ? { OR: [{ razonSocial: { contains: q, mode: "insensitive" } }, { rfc: { contains: q.toUpperCase() } }] } : {}),
      ...(sp.get("conCuenta") === "1" ? { clabe: { not: null } } : {}),
    },
    select: { ...SELECT_PROVEEDOR, _count: { select: { solicitudesCompra: true } } },
    orderBy: { razonSocial: "asc" },
    take: 300,
  });
  return NextResponse.json({
    proveedores: proveedores.map(({ _count, ...p }) => ({ ...p, requisiciones: _count.solicitudesCompra })),
  });
});

export const POST = withHospital(async (req: Request) => {
  const parsed = proveedorSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const { companyId, tieneCredito, diasCredito, ...d } = parsed.data;
  if (!companyId) return error("companyId requerido");
  if (!d.rfc || !d.razonSocial) return error("RFC y razón social requeridos");
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  if (tocaDatosDePago(parsed.data)) await requireClinicalPermission(companyId, user.id, "FINANZAS_ESCRIBIR");

  const existente = await prisma.supplier.findUnique({ where: { companyId_rfc: { companyId, rfc: d.rfc } }, select: SELECT_PROVEEDOR });
  if (existente) return NextResponse.json({ error: `Ya existe un proveedor con RFC ${d.rfc}`, existente }, { status: 409 });

  const creado = await prisma.$transaction(async (tx) => {
    const s = await tx.supplier.create({
      data: {
        companyId, rfc: d.rfc!, razonSocial: d.razonSocial!, regimenFiscal: d.regimenFiscal ?? null, email: d.email ?? null,
        clabe: d.clabe ?? null, banco: d.banco ?? null, titularCuenta: d.titularCuenta ?? null,
      },
      select: { id: true },
    });
    if (tieneCredito !== undefined) await guardarTerminos(tx, s.id, tieneCredito, diasCredito);
    return tx.supplier.findUniqueOrThrow({ where: { id: s.id }, select: SELECT_PROVEEDOR });
  });
  bitacora(user, req, { companyId, accion: "hospital.proveedor.alta", entidad: "Supplier", entidadId: creado.id, detalle: { rfc: creado.rfc, conClabe: !!creado.clabe } });
  return NextResponse.json(creado, { status: 201 });
});
