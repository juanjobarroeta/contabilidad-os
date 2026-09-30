/**
 * GET  /api/hospital/facturacion/global?companyId=&anio=&mes=
 *      Cargos marcados para la factura global a público en general con fecha
 *      en ese mes y aún sin prefactura ni CFDI, con sus conceptos agrupados
 *      (uno por episodio y tasa de IVA) y el total estimado.
 * POST /api/hospital/facturacion/global { companyId, anio, mes, formaPago }
 *      Arma la prefactura global (RFC XAXX010101000, uso S01, información
 *      global mensual) y toma esos cargos; se timbra como cualquier otra en
 *      /prefacturas/[id].
 *
 * Lo cobrado sin factura individual no desaparece: la ley pide amparar esos
 * ingresos con el CFDI global del periodo. Puerta del hospital: página
 * facturacion · caja · cuentas; escribir exige FINANZAS_ESCRIBIR.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error, errorZod } from "@/lib/hospital/http";
import { periodoDeQuery } from "@/lib/hospital/saeh/periodo";
import { assertPuedeEscribir } from "@/lib/subscription";
import { cargosGlobales, conceptosGlobales, prefacturaGlobal } from "@/lib/hospital/facturacion";

const r2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);
  const periodo = periodoDeQuery(searchParams);
  if (!periodo) return error("anio (aaaa) y mes (1-12) inválidos");

  const cargos = await cargosGlobales(prisma, companyId, periodo.anio, periodo.mes);
  const conceptos = conceptosGlobales(cargos);
  const subtotal = r2(conceptos.reduce((s, c) => s + c.product.price, 0));
  const iva = r2(conceptos.reduce((s, c) => s + c.product.price * (c.product.taxes?.[0]?.rate ?? 0), 0));
  return NextResponse.json({
    ...periodo,
    cargos: cargos.map((c) => ({ id: c.id, episodioId: c.episodioId, folio: c.folio, fecha: c.fecha, descripcion: c.descripcion, importe: Number(c.importe), ivaTasa: c.ivaTasa == null ? null : Number(c.ivaTasa) })),
    conceptos: conceptos.map((c) => ({ folio: c.product.sku, importe: c.product.price, iva: c.product.taxes?.[0] })),
    totales: { subtotal, iva, total: r2(subtotal + iva) },
  });
});

const postSchema = z.object({
  companyId: z.string().min(1),
  anio: z.number().int().min(2000).max(2100),
  mes: z.number().int().min(1).max(12),
  formaPago: z.string().min(1).default("01"),
});

export const POST = withHospital(async (req: Request) => {
  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;
  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const r = await prefacturaGlobal({ companyId: d.companyId, anio: d.anio, mes: d.mes, formaPago: d.formaPago, actor: user, req });
  return NextResponse.json(r.body, { status: r.status });
});
