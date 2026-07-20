import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// GET /api/purificadora/reportes/matriz?companyId=xxx&year=2026&month=7[&customerId=]
//
// La vista "NEGOCIOS" del Excel: garrafones por día del mes.
//   - Sin customerId: una fila por empresa (+ una por ventas de casas/rutas).
//   - Con customerId: una fila por sucursal de ese cliente.
// Devuelve { dias, rows: [{ key, nombre, porDia: {1: n, …}, totalGarrafones, totalImporte }] }.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = parseInt(searchParams.get("year") ?? "");
  const month = parseInt(searchParams.get("month") ?? "");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  if (!year || !month || month < 1 || month > 12) {
    return NextResponse.json({ error: "year y month requeridos" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "PURIFICADORA", req);

  const customerId = searchParams.get("customerId")?.trim() || null;
  const desde = new Date(Date.UTC(year, month - 1, 1));
  const hasta = new Date(Date.UTC(year, month, 1));
  const dias = new Date(Date.UTC(year, month, 0)).getUTCDate();

  type Row = {
    key: string;
    nombre: string;
    porDia: Record<number, number>;
    totalGarrafones: number;
    totalImporte: number;
  };
  const rows = new Map<string, Row>();
  const rowFor = (key: string, nombre: string): Row => {
    let r = rows.get(key);
    if (!r) {
      r = { key, nombre, porDia: {}, totalGarrafones: 0, totalImporte: 0 };
      rows.set(key, r);
    }
    return r;
  };

  if (!customerId) {
    const ventas = await prisma.purifVenta.findMany({
      where: { companyId, estado: { not: "CANCELADA" }, fecha: { gte: desde, lt: hasta } },
      select: {
        fecha: true,
        garrafones: true,
        total: true,
        customerId: true,
        customer: { select: { razonSocial: true } },
      },
    });
    for (const v of ventas) {
      const dia = v.fecha.getUTCDate();
      const row = v.customerId
        ? rowFor(v.customerId, v.customer!.razonSocial)
        : rowFor("__casas__", "Casas / rutas");
      row.porDia[dia] = (row.porDia[dia] ?? 0) + v.garrafones;
      row.totalGarrafones += v.garrafones;
      row.totalImporte = round2(row.totalImporte + v.total);
    }
  } else {
    const items = await prisma.purifVentaItem.findMany({
      where: {
        venta: {
          companyId,
          customerId,
          estado: { not: "CANCELADA" },
          fecha: { gte: desde, lt: hasta },
        },
      },
      select: {
        garrafones: true,
        importe: true,
        sucursalId: true,
        sucursal: { select: { nombre: true } },
        venta: { select: { fecha: true } },
      },
    });
    for (const it of items) {
      const dia = it.venta.fecha.getUTCDate();
      const row = it.sucursalId
        ? rowFor(it.sucursalId, it.sucursal!.nombre)
        : rowFor("__sin__", "Sin sucursal");
      row.porDia[dia] = (row.porDia[dia] ?? 0) + it.garrafones;
      row.totalGarrafones += it.garrafones;
      row.totalImporte = round2(row.totalImporte + it.importe);
    }
  }

  const list = [...rows.values()].sort((a, b) => b.totalGarrafones - a.totalGarrafones);
  const totalPorDia: Record<number, number> = {};
  for (const r of list) {
    for (const [d, n] of Object.entries(r.porDia)) {
      totalPorDia[+d] = (totalPorDia[+d] ?? 0) + n;
    }
  }

  return NextResponse.json({ year, month, dias, rows: list, totalPorDia });
});
