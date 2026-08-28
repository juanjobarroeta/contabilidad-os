import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, getEffectiveCompanyMembership, requireUser, requireScope } from "@/lib/authz";
import { estadoDeCuentaCliente } from "@/lib/clientes/estado-cuenta";
import { situaciones69b } from "@/lib/fiscal/verificador/lista69b";

// GET /api/clientes/[id]/estado-cuenta?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
//
// El entregable de cobranza: facturas del cliente como cargos, cobros CON
// EVIDENCIA BANCARIA como abonos, saldo corrido, facturas abiertas con
// antigüedad y el marcador de REP por factura. Sólo lectura. Sesión web o
// bearer (scope "clientes" cuando el token lo restringe).
//
// Rango por default: últimos 3 meses al día de hoy (la historia completa
// alimenta el saldo inicial de todos modos).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser(req);
    requireScope(user, "clientes");

    const { id } = await params;
    const customer = await prisma.customer.findUnique({
      where: { id },
      select: {
        companyId: true, rfc: true, razonSocial: true, email: true, phone: true,
        codigoPostal: true, facturapiId: true,
        _count: { select: { invoices: { where: { tipo: "INGRESO", status: "STAMPED" } } } },
      },
    });
    if (!customer) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const member = await getEffectiveCompanyMembership(user.id, customer.companyId);
    if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const url = new URL(req.url);
    const hoy = new Date();
    const hastaParam = url.searchParams.get("hasta");
    const desdeParam = url.searchParams.get("desde");
    const hasta = hastaParam ? new Date(`${hastaParam}T23:59:59Z`) : hoy;
    const desde = desdeParam
      ? new Date(`${desdeParam}T00:00:00Z`)
      : new Date(Date.UTC(hasta.getUTCFullYear(), hasta.getUTCMonth() - 3, 1));
    if (isNaN(desde.getTime()) || isNaN(hasta.getTime()) || desde > hasta) {
      return NextResponse.json({ error: "Rango de fechas inválido" }, { status: 400 });
    }

    const estado = await estadoDeCuentaCliente(customer.companyId, id, { desde, hasta, hoy });

    // Ficha del cliente (hub): 69-B, Facturapi y REPs emitidos hacia él —
    // todo lo del cliente en una sola página (decisión del owner, pág. 8).
    const uuidsCliente = (
      await prisma.invoice.findMany({
        where: { companyId: customer.companyId, customerId: id, tipo: "INGRESO", status: "STAMPED", uuid: { not: null } },
        select: { uuid: true },
      })
    ).map((f) => f.uuid as string);
    const [sit69b, repsRel] = await Promise.all([
      situaciones69b([customer.rfc]),
      uuidsCliente.length
        ? prisma.pagoDoctoRelacionado.findMany({
            // parentUuid es una cadena sin relación: se filtra por los UUID de
            // las facturas del cliente.
            where: {
              parentUuid: { in: uuidsCliente },
              pagoInvoice: { companyId: customer.companyId, tipo: "PAGO", status: "STAMPED" },
            },
            select: {
              pagoInvoice: { select: { id: true, uuid: true, serie: true, folio: true, fecha: true, total: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    const repsEmitidos = [...new Map(
      repsRel.map((r) => [r.pagoInvoice.id, {
        id: r.pagoInvoice.id,
        uuid: r.pagoInvoice.uuid,
        folio: [r.pagoInvoice.serie, r.pagoInvoice.folio].filter(Boolean).join("-") || null,
        fecha: r.pagoInvoice.fecha,
        total: Number(r.pagoInvoice.total),
      }]),
    ).values()].sort((a, b) => +new Date(b.fecha) - +new Date(a.fecha));

    return NextResponse.json({
      ...estado,
      empresaId: customer.companyId,
      cliente: {
        rfc: customer.rfc,
        razonSocial: customer.razonSocial,
        email: customer.email,
        phone: customer.phone,
        codigoPostal: customer.codigoPostal,
        facturapiId: customer.facturapiId,
        situacion69b: sit69b.get(customer.rfc) ?? null,
        facturas: customer._count.invoices,
      },
      repsEmitidos,
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    const msg = e instanceof Error ? e.message : "Error generando el estado de cuenta";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
