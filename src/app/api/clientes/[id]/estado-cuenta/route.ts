import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, getEffectiveCompanyMembership, requireUser, requireScope } from "@/lib/authz";
import { estadoDeCuentaCliente } from "@/lib/clientes/estado-cuenta";

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
      select: { companyId: true },
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
    return NextResponse.json(estado);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    const msg = e instanceof Error ? e.message : "Error generando el estado de cuenta";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
