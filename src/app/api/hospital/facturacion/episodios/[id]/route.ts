/**
 * GET  /api/hospital/facturacion/episodios/[id]?companyId=
 *      La cuenta vista para facturar: cada cargo con su estado (pendiente, en
 *      prefactura, a la global, facturado, honorario, cancelado), sus claves
 *      SAT, los receptores sugeridos (pagador, receptor fiscal, paciente) y
 *      los totales por estado.
 *
 * POST /api/hospital/facturacion/episodios/[id]
 *   { accion: "prefactura", companyId, customerId, cargoIds[], formaPago, metodoPago, usoCfdi, notes? }
 *        prefactura con esos cargos a ese receptor (los cargos quedan tomados)
 *   { accion: "publico-general", companyId, cargoIds[], valor }
 *        marca o regresa cargos de la factura global del mes
 *   { accion: "dividir", companyId, cargoId, cantidad? | importe? }
 *        parte un cargo en dos que suman lo mismo
 *
 * Puerta del hospital (lib/hospital/permisos.ts): página facturacion · caja ·
 * cuentas; escribir exige FINANZAS_ESCRIBIR. Reglas: lib/hospital/facturacion.ts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { dividirCargo, facturacionEpisodio, marcarPublicoGeneral, prefacturaDesdeCargos } from "@/lib/hospital/facturacion";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  return NextResponse.json(await facturacionEpisodio(prisma, companyId, id));
});

const ids = z.array(z.string().min(1)).min(1).max(500);
const bodySchema = z.discriminatedUnion("accion", [
  z.object({
    accion: z.literal("prefactura"),
    companyId: z.string().min(1),
    customerId: z.string().min(1),
    cargoIds: ids,
    formaPago: z.string().min(1),
    metodoPago: z.enum(["PUE", "PPD"]),
    usoCfdi: z.string().min(1),
    notes: z.string().max(1000).optional(),
  }),
  z.object({ accion: z.literal("publico-general"), companyId: z.string().min(1), cargoIds: ids, valor: z.boolean() }),
  z.object({
    accion: z.literal("dividir"),
    companyId: z.string().min(1),
    cargoId: z.string().min(1),
    cantidad: z.number().positive().optional(),
    importe: z.number().positive().optional(),
  }),
]);

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;
  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);

  if (d.accion === "prefactura") {
    const r = await prefacturaDesdeCargos({
      companyId: d.companyId,
      episodioId: id,
      customerId: d.customerId,
      cargoIds: d.cargoIds,
      datos: { formaPago: d.formaPago, metodoPago: d.metodoPago, usoCfdi: d.usoCfdi, notes: d.notes?.trim() || undefined },
      actor: user,
      req,
    });
    return NextResponse.json(r.body, { status: r.status });
  }

  if (d.accion === "publico-general") {
    const r = await marcarPublicoGeneral(prisma, d.companyId, id, d.cargoIds, d.valor);
    bitacora(user, req, {
      companyId: d.companyId,
      accion: d.valor ? "hospital.facturacion.publico-general" : "hospital.facturacion.publico-general.quitar",
      entidad: "HospEpisodio",
      entidadId: id,
      detalle: { cargoIds: d.cargoIds },
    });
    return NextResponse.json(r);
  }

  if ((d.cantidad == null) === (d.importe == null)) return error("Indica la cantidad o el importe a separar (uno de los dos)");
  const r = await prisma.$transaction((tx) =>
    dividirCargo(tx, { companyId: d.companyId, episodioId: id, cargoId: d.cargoId, cantidad: d.cantidad, importe: d.importe, userId: user.id }),
  );
  bitacora(user, req, {
    companyId: d.companyId,
    accion: "hospital.facturacion.dividir-cargo",
    entidad: "HospCargo",
    entidadId: d.cargoId,
    detalle: { ...r, cantidad: d.cantidad, importe: d.importe },
  });
  return NextResponse.json(r, { status: 201 });
});
