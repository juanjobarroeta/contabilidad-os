/**
 * GET    /api/hospital/facturacion/prefacturas/[id]  — payload completo + receptor
 * PUT    /api/hospital/facturacion/prefacturas/[id]  — editar (draft nuevo, misma fila)
 * POST   /api/hospital/facturacion/prefacturas/[id]  { accion: "timbrar" } | { accion: "enviar", email? }
 * DELETE /api/hospital/facturacion/prefacturas/[id]  — descartar
 *
 * Mismas reglas que /api/facturas/borradores/[id] (lib/facturas/prefacturas.ts)
 * con la puerta del hospital: página facturacion · caja · cuentas y, para
 * escribir —timbrar incluido—, FINANZAS_ESCRIBIR.
 */

import { NextResponse } from "next/server";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import type { StampInput } from "@/lib/facturas/stamp";
import { prefacturaSchema } from "@/lib/facturas/prefactura";
import {
  cargarPrefactura,
  descartarPrefactura,
  detallePrefactura,
  editarPrefactura,
  enviarPrefactura,
  timbrarPrefactura,
} from "@/lib/facturas/prefacturas";

type Ctx = { params: Promise<{ id: string }> };

const NO_ENCONTRADA = "Prefactura no encontrada";

/** Autoriza escritura sobre la prefactura y devuelve el actor. */
async function escritor(companyId: string, req: Request) {
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  return user;
}

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const borrador = await detallePrefactura(id);
  if (!borrador) return error(NO_ENCONTRADA, 404);
  await requireMembership(borrador.companyId, undefined, req);
  await requireModule(borrador.companyId, "HOSPITAL", req);
  return NextResponse.json(borrador);
});

export const PUT = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const borrador = await cargarPrefactura(id);
  if (!borrador) return error(NO_ENCONTRADA, 404);
  const user = await escritor(borrador.companyId, req);
  const parsed = prefacturaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const r = await editarPrefactura(borrador, parsed.data as StampInput, user, req);
  return NextResponse.json(r.body, { status: r.status });
});

export const POST = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const borrador = await cargarPrefactura(id);
  if (!borrador) return error(NO_ENCONTRADA, 404);
  const user = await escritor(borrador.companyId, req);
  const body = (await req.json().catch(() => null)) as { accion?: string; email?: string } | null;
  if (body?.accion === "timbrar") {
    const r = await timbrarPrefactura(borrador, user, req);
    return NextResponse.json(r.body, { status: r.status });
  }
  if (body?.accion === "enviar") {
    const r = await enviarPrefactura(borrador, body.email, user, req);
    return NextResponse.json(r.body, { status: r.status });
  }
  return error("accion debe ser 'timbrar' o 'enviar'");
});

export const DELETE = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const borrador = await cargarPrefactura(id);
  if (!borrador) return error(NO_ENCONTRADA, 404);
  const user = await escritor(borrador.companyId, req);
  const r = await descartarPrefactura(borrador, user, req);
  return NextResponse.json(r.body, { status: r.status });
});
