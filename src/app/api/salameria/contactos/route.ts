/**
 * GET /api/salameria/contactos?companyId=… [&q=]
 *
 * El directorio, DERIVADO DE LOS CFDIs — mismo criterio que automotriz y
 * hospital: un contacto es cliente si le hemos emitido facturas (INGRESO) y
 * proveedor si nos ha facturado (EGRESO). Puede ser las dos cosas, y en un
 * importador eso pasa seguido (el que te trae la mercancía también te compra).
 *
 * POR QUÉ DERIVADO Y NO UNA TABLA PROPIA: el hub ya guarda la contraparte de
 * TODO CFDI como `Customer` por RFC. Un directorio propio del módulo sería un
 * segundo padrón que se desincroniza en cuanto entre una factura por el sync
 * del SAT y nadie la copie a mano.
 *
 * Suma lo de la Salamería: la cuenta de la tienda ligada a ese RFC y cuántos
 * pedidos lleva, para que desde el mismo renglón se vea al mayorista completo.
 * Sólo lectura.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const r2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "SALAMERIA", req);

  const q = searchParams.get("q");

  const [contactos, porDireccion, cuentas, pedidosPorCliente] = await Promise.all([
    prisma.customer.findMany({
      where: {
        companyId,
        ...(q
          ? {
              OR: [
                { razonSocial: { contains: q, mode: "insensitive" as const } },
                { rfc: { contains: q, mode: "insensitive" as const } },
              ],
            }
          : {}),
      },
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
      _max: { fecha: true },
    }),
    prisma.salCuenta.findMany({
      where: { companyId, customerId: { not: null } },
      select: {
        id: true,
        email: true,
        customerId: true,
        activa: true,
        diasCredito: true,
        lista: { select: { nombre: true, tipo: true } },
      },
    }),
    prisma.salPedido.groupBy({
      by: ["customerId"],
      where: { companyId, customerId: { not: null }, estado: { not: "CARRITO" } },
      _count: { _all: true },
      _sum: { total: true },
    }),
  ]);

  const porContacto = new Map<
    string,
    { fI: number; mI: number; fE: number; mE: number; ultima: Date | null }
  >();
  for (const g of porDireccion) {
    if (!g.customerId) continue;
    const fila =
      porContacto.get(g.customerId) ?? { fI: 0, mI: 0, fE: 0, mE: 0, ultima: null };
    if (g.tipo === "INGRESO") {
      fila.fI += g._count._all;
      fila.mI += Number(g._sum.total ?? 0);
    } else {
      fila.fE += g._count._all;
      fila.mE += Number(g._sum.total ?? 0);
    }
    const max = g._max.fecha ?? null;
    if (max && (!fila.ultima || max > fila.ultima)) fila.ultima = max;
    porContacto.set(g.customerId, fila);
  }

  // Un RFC puede tener más de una cuenta de tienda (dos compradores del mismo
  // negocio); la fila enseña la primera y las demás siguen en Clientes.
  const cuentaPorCustomer = new Map<string, (typeof cuentas)[number]>();
  for (const c of cuentas) {
    if (c.customerId && !cuentaPorCustomer.has(c.customerId)) {
      cuentaPorCustomer.set(c.customerId, c);
    }
  }
  const pedidosPorCustomer = new Map(
    pedidosPorCliente
      .filter((p) => p.customerId)
      .map((p) => [
        p.customerId as string,
        { n: p._count._all, monto: Number(p._sum.total ?? 0) },
      ])
  );

  const filas = contactos
    .map((c) => {
      const d = porContacto.get(c.id) ?? { fI: 0, mI: 0, fE: 0, mE: 0, ultima: null };
      const cuenta = cuentaPorCustomer.get(c.id) ?? null;
      const pedidos = pedidosPorCustomer.get(c.id) ?? { n: 0, monto: 0 };
      return {
        ...c,
        esCliente: d.fI > 0,
        esProveedor: d.fE > 0,
        facturasCliente: d.fI,
        montoCliente: r2(d.mI),
        facturasProveedor: d.fE,
        montoProveedor: r2(d.mE),
        ultimaFactura: d.ultima,
        cuentaId: cuenta?.id ?? null,
        cuentaEmail: cuenta?.email ?? null,
        cuentaActiva: cuenta?.activa ?? null,
        cuentaLista: cuenta?.lista?.nombre ?? null,
        cuentaMayoreo: cuenta ? cuenta.lista?.tipo !== "MENUDEO" && !!cuenta.lista : false,
        diasCredito: cuenta?.diasCredito ?? 0,
        pedidos: pedidos.n,
        montoPedidos: r2(pedidos.monto),
      };
    })
    .sort(
      (a, b) => b.montoCliente + b.montoProveedor - (a.montoCliente + a.montoProveedor)
    );

  return NextResponse.json(filas);
});
