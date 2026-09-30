/**
 * GET /api/hospital/facturacion/facturas?companyId=[&q=][&take=]
 *
 * Las facturas de ingreso emitidas, más recientes primero, con lo que la
 * pantalla de Facturación necesita para cancelarlas o sustituirlas: estado y
 * estado de la cancelación ante el SAT, la relación declarada (04 sustitución)
 * y cuántos cargos de una cuenta ampara (sin ellos, la sustitución se arma a
 * mano). `q` busca por receptor, RFC, UUID o folio. Sólo lectura.
 */

import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const q = searchParams.get("q")?.trim();
  const take = Math.min(Math.max(Number(searchParams.get("take")) || 50, 1), 200);
  const where: Prisma.InvoiceWhereInput = {
    companyId,
    tipo: "INGRESO",
    uuid: { not: null },
    ...(q
      ? {
          OR: [
            { uuid: { contains: q.toUpperCase() } },
            { folio: { contains: q, mode: "insensitive" } },
            { customer: { razonSocial: { contains: q, mode: "insensitive" } } },
            { customer: { rfc: { contains: q.toUpperCase() } } },
          ],
        }
      : {}),
  };
  const facturas = await prisma.invoice.findMany({
    where,
    orderBy: { fecha: "desc" },
    take,
    select: {
      id: true, uuid: true, serie: true, folio: true, fecha: true, total: true, metodoPago: true, formaPago: true, usoCfdi: true,
      status: true, cancelEstadoSat: true, cancelMotivo: true, cancelSustituyeUuid: true, cancelSolicitadaAt: true,
      tipoRelacion: true, cfdiRelacionadoUuid: true,
      customer: { select: { id: true, razonSocial: true, rfc: true } },
      _count: { select: { hospCargos: true } },
    },
  });
  return NextResponse.json({
    facturas: facturas.map(({ _count, total, ...f }) => ({ ...f, total: Number(total), cargosHospital: _count.hospCargos })),
  });
});
