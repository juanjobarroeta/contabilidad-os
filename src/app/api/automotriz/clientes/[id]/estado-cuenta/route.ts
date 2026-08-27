import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/clientes/[id]/estado-cuenta?year=2026
//
// Estado de cuenta del cliente, 100% documental (derivado de CFDIs):
//   CARGO  → factura INGRESO (no NC, no cancelada).
//   ABONO  → nota de crédito emitida (tipoSat E), REP (complemento de pago,
//            con su FechaPago legal), pago implícito PUE (liquidada en su
//            emisión — misma regla de evidencia que la cartera) y cobro
//            conciliado en banco que excede lo amparado por REP.
// Saldo corrido + saldo anterior al ejercicio. Sólo lectura.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

type Mov = {
  fecha: Date;
  tipo: "FACTURA" | "NOTA_CREDITO" | "PAGO_REP" | "PAGO_PUE" | "COBRO_BANCO";
  referencia: string | null;
  invoiceId: string | null;
  concepto: string;
  cargo: number;
  abono: number;
};

export const GET = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const { searchParams } = new URL(req.url);

  const cliente = await prisma.customer.findUnique({
    where: { id },
    select: { id: true, companyId: true, razonSocial: true, rfc: true, email: true, phone: true },
  });
  if (!cliente) throw new AuthzError(404, "Cliente no encontrado");
  await requireMembership(cliente.companyId, undefined, req);
  await requireModule(cliente.companyId, "AUTOMOTRIZ", req);

  const year = Number(searchParams.get("year") ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Ejercicio inválido" }, { status: 400 });
  }
  const inicio = new Date(year, 0, 1);
  const fin = new Date(year + 1, 0, 1);

  const facturas = await prisma.invoice.findMany({
    where: { companyId: cliente.companyId, customerId: id, tipo: "INGRESO", status: { not: "CANCELLED" } },
    select: {
      id: true, uuid: true, serie: true, folio: true, fecha: true, total: true,
      metodoPago: true, tipoSat: true,
      conciliacionDetalles: { select: { montoAsignado: true } },
    },
    orderBy: { fecha: "asc" },
  });

  const uuids = facturas.filter((f) => f.tipoSat !== "E").map((f) => f.uuid).filter(Boolean) as string[];
  const reps = uuids.length
    ? await prisma.pagoDoctoRelacionado.findMany({
        where: { parentUuid: { in: variantesUuid(uuids) } },
        select: { parentUuid: true, impPagado: true, numParcialidad: true, fechaPago: true, pagoInvoiceId: true },
      })
    : [];

  const ref = (f: { serie: string | null; folio: string | null }) =>
    [f.serie, f.folio].filter(Boolean).join("-") || null;
  const refPorUuid = new Map(
    facturas.filter((f) => f.uuid).map((f) => [normalizarUuid(f.uuid!), { ref: ref(f), id: f.id, fecha: f.fecha }])
  );

  const movimientos: Mov[] = [];
  const repPorFactura = new Map<string, number>();
  for (const r of reps) {
    const k = normalizarUuid(r.parentUuid);
    repPorFactura.set(k, (repPorFactura.get(k) ?? 0) + (r.impPagado ?? 0));
    const padre = refPorUuid.get(k);
    movimientos.push({
      fecha: r.fechaPago ?? padre?.fecha ?? new Date(),
      tipo: "PAGO_REP",
      referencia: padre?.ref ?? null,
      invoiceId: r.pagoInvoiceId,
      concepto: `Pago (REP${r.numParcialidad ? ` parcialidad ${r.numParcialidad}` : ""}) de ${padre?.ref ?? "factura"}`,
      cargo: 0,
      abono: r.impPagado ?? 0,
    });
  }

  for (const f of facturas) {
    if (f.tipoSat === "E") {
      movimientos.push({
        fecha: f.fecha, tipo: "NOTA_CREDITO", referencia: ref(f), invoiceId: f.id,
        concepto: `Nota de crédito ${ref(f) ?? ""}`.trim(), cargo: 0, abono: f.total,
      });
      continue;
    }
    movimientos.push({
      fecha: f.fecha, tipo: "FACTURA", referencia: ref(f), invoiceId: f.id,
      concepto: `Factura ${ref(f) ?? ""}`.trim(), cargo: f.total, abono: 0,
    });
    const conciliado = f.conciliacionDetalles.reduce((s, d) => s + Math.abs(Number(d.montoAsignado)), 0);
    const rep = f.uuid ? (repPorFactura.get(normalizarUuid(f.uuid)) ?? 0) : 0;
    if (f.metodoPago === "PPD") {
      // Banco por encima de lo amparado con REP (el REP ya tiene su renglón).
      const excedente = Math.max(0, Math.min(conciliado, f.total) - rep);
      if (excedente > 0.01) {
        movimientos.push({
          fecha: f.fecha, tipo: "COBRO_BANCO", referencia: ref(f), invoiceId: f.id,
          concepto: `Cobro conciliado en banco de ${ref(f) ?? "factura"} (sin REP)`,
          cargo: 0, abono: excedente,
        });
      }
    } else {
      // PUE: liquidada en su emisión (misma regla de evidencia que la cartera).
      movimientos.push({
        fecha: f.fecha, tipo: "PAGO_PUE", referencia: ref(f), invoiceId: f.id,
        concepto: `Pago de ${ref(f) ?? "factura"} (PUE — una sola exhibición)`,
        cargo: 0, abono: f.total,
      });
    }
  }

  movimientos.sort((a, b) => +a.fecha - +b.fecha || a.cargo - b.cargo || (a.cargo > 0 ? -1 : 1));

  const saldoAnterior = r2(
    movimientos.filter((m) => m.fecha < inicio).reduce((s, m) => s + m.cargo - m.abono, 0)
  );
  const delEjercicio = movimientos.filter((m) => m.fecha >= inicio && m.fecha < fin);

  let saldo = saldoAnterior;
  const conSaldo = delEjercicio.map((m) => {
    saldo = r2(saldo + m.cargo - m.abono);
    return { ...m, cargo: r2(m.cargo), abono: r2(m.abono), saldo };
  });

  return NextResponse.json({
    cliente,
    year,
    saldoAnterior,
    movimientos: conSaldo,
    resumen: {
      cargos: r2(delEjercicio.reduce((s, m) => s + m.cargo, 0)),
      abonos: r2(delEjercicio.reduce((s, m) => s + m.abono, 0)),
      saldoFinal: saldo,
      movimientos: conSaldo.length,
    },
  });
});
