import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/rentabilidad?companyId=…&year=2026
//
// Rentabilidad de las VENTAS (la razón de ser de todos los datos derivados):
// por unidad vendida en el ejercicio — precio de venta, costo de compra,
// costos atribuidos (fletes/seguros positivos, notas de crédito NEGATIVAS),
// interés de plan piso y comisión — y agregados por mes, por marca y por
// vendedor. Las facturas canceladas nunca llegan aquí (la unidad liga la
// refactura vigente). Solo lectura.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const year = Number(searchParams.get("year") ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Ejercicio inválido" }, { status: 400 });
  }
  const desde = new Date(year, 0, 1);
  const hasta = new Date(year + 1, 0, 1);

  const vendidas = await prisma.vehiculo.findMany({
    where: {
      companyId,
      estado: { in: ["VENDIDO", "ENTREGADO"] },
      fechaVenta: { gte: desde, lt: hasta },
      precioVenta: { not: null },
    },
    select: {
      id: true, vin: true, marca: true, modelo: true, anio: true, tipo: true,
      fechaVenta: true, precioVenta: true, costoCompra: true, comisionMonto: true,
      cliente: { select: { id: true, razonSocial: true } },
      vendedor: { select: { id: true, nombre: true, apellidoPaterno: true } },
      ventaInvoiceId: true,
      costos: { select: { tipo: true, monto: true } },
    },
    orderBy: { fechaVenta: "desc" },
  });

  const unidades = vendidas.map((v) => {
    const costosTotal = v.costos.reduce((s, c) => s + c.monto, 0); // NC restan solas
    const interesPiso = v.costos.filter((c) => c.tipo === "INTERES_PISO").reduce((s, c) => s + c.monto, 0);
    const notasCredito = v.costos.filter((c) => c.monto < 0).reduce((s, c) => s + c.monto, 0);
    // Costo incompleto: la compra quedó fuera del archivo de 5 años del SAT y
    // nadie ha capturado el costo real — su "utilidad" sería la venta entera.
    // Se reporta aparte y NO entra a utilidad/margen agregados.
    const costoIncompleto = v.costoCompra <= 0;
    const utilidad = (v.precioVenta ?? 0) - v.costoCompra - costosTotal - v.comisionMonto;
    return {
      id: v.id,
      vin: v.vin,
      unidad: `${v.marca} ${v.modelo} ${v.anio}`,
      marca: v.marca,
      tipo: v.tipo,
      fechaVenta: v.fechaVenta,
      cliente: v.cliente?.razonSocial ?? (v.ventaInvoiceId ? "Público en general" : null),
      vendedor: v.vendedor ? `${v.vendedor.nombre} ${v.vendedor.apellidoPaterno}` : null,
      precioVenta: v.precioVenta ?? 0,
      costoCompra: v.costoCompra,
      costosAdicionales: r2(costosTotal - notasCredito - interesPiso),
      notasCredito: r2(-notasCredito), // positivo = monto acreditado a favor
      interesPiso: r2(interesPiso),
      comision: v.comisionMonto,
      costoIncompleto,
      utilidad: costoIncompleto ? null : r2(utilidad),
      margen: !costoIncompleto && v.precioVenta ? r2((utilidad / v.precioVenta) * 100) : null,
    };
  });
  const completas = unidades.filter((u) => !u.costoIncompleto);

  type Agg = { unidades: number; venta: number; utilidad: number };
  const agrega = (clave: (u: (typeof unidades)[number]) => string | null) => {
    const m = new Map<string, Agg>();
    for (const u of completas) {
      const k = clave(u);
      if (k == null) continue;
      const a = m.get(k) ?? { unidades: 0, venta: 0, utilidad: 0 };
      a.unidades++;
      a.venta = r2(a.venta + u.precioVenta);
      a.utilidad = r2(a.utilidad + (u.utilidad ?? 0));
      m.set(k, a);
    }
    return [...m.entries()]
      .map(([k, a]) => ({ clave: k, ...a, margen: a.venta ? r2((a.utilidad / a.venta) * 100) : null }))
      .sort((a, b) => b.utilidad - a.utilidad);
  };

  const ventaCompletas = r2(completas.reduce((s, u) => s + u.precioVenta, 0));
  const totalUtilidad = r2(completas.reduce((s, u) => s + (u.utilidad ?? 0), 0));
  const incompletas = unidades.filter((u) => u.costoIncompleto);

  return NextResponse.json({
    year,
    resumen: {
      unidades: unidades.length,
      venta: r2(unidades.reduce((s, u) => s + u.precioVenta, 0)),
      // Utilidad y margen SÓLO sobre unidades con costo conocido.
      utilidad: totalUtilidad,
      margen: ventaCompletas ? r2((totalUtilidad / ventaCompletas) * 100) : null,
      notasCredito: r2(unidades.reduce((s, u) => s + u.notasCredito, 0)),
      incompletas: {
        unidades: incompletas.length,
        venta: r2(incompletas.reduce((s, u) => s + u.precioVenta, 0)),
      },
    },
    porMes: agrega((u) => (u.fechaVenta ? `${year}-${String(new Date(u.fechaVenta).getMonth() + 1).padStart(2, "0")}` : null)).sort((a, b) => a.clave.localeCompare(b.clave)),
    porMarca: agrega((u) => u.marca),
    porVendedor: agrega((u) => u.vendedor),
    unidades,
  });
});
