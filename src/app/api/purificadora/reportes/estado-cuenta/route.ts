import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/purificadora/reportes/estado-cuenta?companyId=xxx&customerId=yyy&year=2026&month=6
//
// El estado de cuenta mensual por cliente (la tabla "CONSUMO GRUPO STELLA"):
// garrafones y total por sucursal, ventas del periodo, saldo pendiente y los
// datos para facturar el consumo (precio, claves SAT del PurifConfig).
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const customerId = searchParams.get("customerId");
  const year = parseInt(searchParams.get("year") ?? "");
  const month = parseInt(searchParams.get("month") ?? "");
  if (!companyId || !customerId) {
    return NextResponse.json({ error: "companyId y customerId requeridos" }, { status: 400 });
  }
  if (!year || !month || month < 1 || month > 12) {
    return NextResponse.json({ error: "year y month requeridos" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, companyId: true, razonSocial: true, rfc: true, facturapiId: true },
  });
  if (!customer || customer.companyId !== companyId) {
    return NextResponse.json({ error: "Cliente inválido" }, { status: 400 });
  }

  const desde = new Date(Date.UTC(year, month - 1, 1));
  const hasta = new Date(Date.UTC(year, month, 1));

  const [ventas, config, clienteConfig] = await Promise.all([
    prisma.purifVenta.findMany({
      where: {
        companyId,
        customerId,
        estado: { not: "CANCELADA" },
        fecha: { gte: desde, lt: hasta },
      },
      include: { items: { include: { sucursal: { select: { id: true, nombre: true } } } } },
      orderBy: { fecha: "asc" },
    }),
    prisma.purifConfig.findUnique({ where: { companyId } }),
    prisma.purifClienteConfig.findUnique({
      where: { companyId_customerId: { companyId, customerId } },
    }),
  ]);

  type SucRow = { sucursalId: string | null; nombre: string; garrafones: number; total: number };
  const porSucursal = new Map<string, SucRow>();
  for (const v of ventas) {
    for (const it of v.items) {
      const key = it.sucursalId ?? "__sin__";
      let row = porSucursal.get(key);
      if (!row) {
        row = {
          sucursalId: it.sucursalId,
          nombre: it.sucursal?.nombre ?? "Sin sucursal",
          garrafones: 0,
          total: 0,
        };
        porSucursal.set(key, row);
      }
      row.garrafones += it.garrafones;
      row.total = round2(row.total + it.importe);
    }
  }

  const totalGarrafones = ventas.reduce((s, v) => s + v.garrafones, 0);
  const total = round2(ventas.reduce((s, v) => s + v.total, 0));
  const pendiente = round2(
    ventas.filter((v) => v.estado === "PENDIENTE").reduce((s, v) => s + v.total, 0)
  );
  const yaFacturado = ventas.some((v) => v.invoiceId);

  return NextResponse.json({
    customer: {
      id: customer.id,
      razonSocial: customer.razonSocial,
      rfc: customer.rfc,
      facturable: !!customer.facturapiId,
    },
    year,
    month,
    precioGarrafon: clienteConfig?.precioGarrafon ?? config?.precioGarrafon ?? 15,
    sucursales: [...porSucursal.values()].sort((a, b) => b.garrafones - a.garrafones),
    ventas: ventas.map((v) => ({
      id: v.id,
      folio: v.folio,
      fecha: v.fecha,
      garrafones: v.garrafones,
      total: v.total,
      estado: v.estado,
      invoiceId: v.invoiceId,
    })),
    totalGarrafones,
    total,
    saldoPendiente: pendiente,
    yaFacturado,
    factura: {
      claveProdServ: config?.claveProdServ ?? "50202306",
      claveUnidad: config?.claveUnidad ?? "H87",
      descripcion: config?.descripcionFactura ?? "Agua purificada en garrafón 20 L",
      ivaTasa: config?.ivaTasaDefault ?? 0,
    },
  });
});
