/**
 * GET /api/automotriz/contactos?companyId=…
 *
 * Directorio de contactos con su dirección comercial derivada de los CFDIs
 * (handoff 3e: chips Todos / Clientes / Proveedores). Un contacto es cliente
 * si le hemos emitido facturas (INGRESO) y proveedor si nos ha facturado
 * (EGRESO) — puede ser ambos. Incluye conteos y montos por lado para ordenar
 * el directorio por relevancia. Sólo lectura.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const r2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const [contactos, porDireccion] = await Promise.all([
    prisma.customer.findMany({
      where: { companyId },
      select: { id: true, razonSocial: true, rfc: true, email: true, phone: true },
    }),
    prisma.invoice.groupBy({
      by: ["customerId", "tipo"],
      where: {
        companyId,
        customerId: { not: null },
        tipo: { in: ["INGRESO", "EGRESO"] },
        status: { not: "CANCELLED" },
      },
      _count: { _all: true },
      _sum: { total: true },
    }),
  ]);

  const porContacto = new Map<string, { fI: number; mI: number; fE: number; mE: number }>();
  for (const g of porDireccion) {
    if (!g.customerId) continue;
    const fila = porContacto.get(g.customerId) ?? { fI: 0, mI: 0, fE: 0, mE: 0 };
    if (g.tipo === "INGRESO") {
      fila.fI += g._count._all;
      fila.mI += Number(g._sum.total ?? 0);
    } else {
      fila.fE += g._count._all;
      fila.mE += Number(g._sum.total ?? 0);
    }
    porContacto.set(g.customerId, fila);
  }

  const filas = contactos
    .map((c) => {
      const d = porContacto.get(c.id) ?? { fI: 0, mI: 0, fE: 0, mE: 0 };
      return {
        ...c,
        esCliente: d.fI > 0,
        esProveedor: d.fE > 0,
        facturasCliente: d.fI,
        montoCliente: r2(d.mI),
        facturasProveedor: d.fE,
        montoProveedor: r2(d.mE),
      };
    })
    .sort((a, b) => (b.montoCliente + b.montoProveedor) - (a.montoCliente + a.montoProveedor));

  return NextResponse.json(filas);
});
