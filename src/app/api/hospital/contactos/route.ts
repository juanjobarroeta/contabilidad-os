/**
 * GET /api/hospital/contactos?companyId=…
 *
 * Directorio del hospital derivado de los CFDIs, con el MISMO criterio que
 * automotriz/contactos: un contacto es cliente si le hemos emitido facturas
 * (INGRESO) y proveedor si nos ha facturado (EGRESO) — puede ser ambos. Suma
 * lo hospitalario: el CONVENIO (HospPagador) que factura a este RFC, para que
 * la cartera se lea por pagador, y cuántos pacientes lo tienen como receptor
 * fiscal por default. Sólo lectura.
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
  await requireModule(companyId, "HOSPITAL", req);

  const [contactos, porDireccion, pagadores, pacientesPorReceptor] = await Promise.all([
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
    prisma.hospPagador.findMany({
      where: { companyId, customerId: { not: null } },
      select: { id: true, nombre: true, tipo: true, customerId: true, activo: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.hospPaciente.groupBy({
      by: ["customerId"],
      where: { companyId, customerId: { not: null } },
      _count: { _all: true },
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
  // Un RFC puede tener más de un convenio (GNP gastos médicos / GNP vida):
  // el más antiguo es el que se enseña en la fila; los demás siguen en su
  // pantalla de convenios.
  const pagadorPorCustomer = new Map<string, { id: string; nombre: string; tipo: string }>();
  for (const p of pagadores) {
    if (p.customerId && !pagadorPorCustomer.has(p.customerId)) pagadorPorCustomer.set(p.customerId, p);
  }
  const pacientesPorCustomer = new Map(
    pacientesPorReceptor.filter((p) => p.customerId).map((p) => [p.customerId as string, p._count._all])
  );

  const filas = contactos
    .map((c) => {
      const d = porContacto.get(c.id) ?? { fI: 0, mI: 0, fE: 0, mE: 0 };
      const pagador = pagadorPorCustomer.get(c.id) ?? null;
      return {
        ...c,
        esCliente: d.fI > 0,
        esProveedor: d.fE > 0,
        facturasCliente: d.fI,
        montoCliente: r2(d.mI),
        facturasProveedor: d.fE,
        montoProveedor: r2(d.mE),
        pagadorId: pagador?.id ?? null,
        pagadorNombre: pagador?.nombre ?? null,
        pagadorTipo: pagador?.tipo ?? null,
        pacientes: pacientesPorCustomer.get(c.id) ?? 0,
      };
    })
    .sort((a, b) => (b.montoCliente + b.montoProveedor) - (a.montoCliente + a.montoProveedor));

  return NextResponse.json(filas);
});
