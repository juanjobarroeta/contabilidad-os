import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/hospital/contactos/[id]/estado-cuenta?direccion=CLIENTE|PROVEEDOR&year=2026
//
// Estado de cuenta 100 % documental (derivado de CFDIs), en las dos
// direcciones — mismo motor que automotriz/clientes/[id]/estado-cuenta:
//   CLIENTE   → lo que le facturamos (INGRESO) y lo que nos ha pagado.
//   PROVEEDOR → lo que nos facturó (EGRESO) y lo que le hemos pagado.
//   CARGO  → factura (no NC, no cancelada).
//   ABONO  → nota de crédito (tipoSat E), REP (complemento de pago, con su
//            FechaPago legal — del lado proveedor es el REP que ÉL emite y
//            que liga por UUID a la factura que recibimos), pago implícito
//            PUE (liquidada en su emisión — misma regla de evidencia que la
//            cartera) y pago/cobro conciliado en banco que excede lo amparado
//            por REP.
// Saldo corrido + saldo anterior al ejercicio. Sólo lectura.
//
// Cada pago se aplica a LA factura que dice su XML, sin pasar de lo que esa
// factura debe: un REP de 2026 que paga facturas de 2025 abona a esas
// facturas (que vienen en el saldo anterior), nunca de más. Si una PUE trae
// REP, el REP es la evidencia y la PUE implícita cubre sólo el resto. Sólo
// cuentan CFDIs vigentes: ni cancelados ni sustituidos (TipoRelacion 04).
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
  const direccion = searchParams.get("direccion") === "PROVEEDOR" ? "PROVEEDOR" : "CLIENTE";

  const contacto = await prisma.customer.findUnique({
    where: { id },
    select: { id: true, companyId: true, razonSocial: true, rfc: true, email: true, phone: true },
  });
  if (!contacto) throw new AuthzError(404, "Contacto no encontrado");
  await requireMembership(contacto.companyId, undefined, req);
  await requireModule(contacto.companyId, "HOSPITAL", req);

  const year = Number(searchParams.get("year") ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return NextResponse.json({ error: "Ejercicio inválido" }, { status: 400 });
  }
  const inicio = new Date(year, 0, 1);
  const fin = new Date(year + 1, 0, 1);

  // Del lado proveedor el «pago» sale de nuestro banco; del lado cliente entra.
  const tipo = direccion === "CLIENTE" ? "INGRESO" : "EGRESO";
  const verboBanco = direccion === "CLIENTE" ? "Cobro" : "Pago";

  const facturas = (
    await prisma.invoice.findMany({
      where: { companyId: contacto.companyId, customerId: id, tipo, status: { not: "CANCELLED" }, sustituidoPorUuid: null },
      select: {
        id: true, uuid: true, serie: true, folio: true, fecha: true, total: true,
        metodoPago: true, tipoSat: true,
        conciliacionDetalles: { select: { montoAsignado: true } },
      },
      orderBy: { fecha: "asc" },
    })
  ).map((f) => ({ ...f, total: Number(f.total) }));

  const uuids = facturas.filter((f) => f.tipoSat !== "E").map((f) => f.uuid).filter(Boolean) as string[];
  const reps = uuids.length
    ? await prisma.pagoDoctoRelacionado.findMany({
        where: {
          parentUuid: { in: variantesUuid(uuids) },
          // Mismo criterio que amparadoPorReps: un REP cancelado o sustituido no paga nada.
          pagoInvoice: { companyId: contacto.companyId, tipo: "PAGO", status: { not: "CANCELLED" }, sustituidoPorUuid: null },
        },
        select: { parentUuid: true, impPagado: true, numParcialidad: true, fechaPago: true, pagoInvoiceId: true, pagoInvoice: { select: { fecha: true } } },
      })
    : [];
  reps.sort((a, b) => +(a.fechaPago ?? a.pagoInvoice.fecha) - +(b.fechaPago ?? b.pagoInvoice.fecha));

  const ref = (f: { serie: string | null; folio: string | null }) =>
    [f.serie, f.folio].filter(Boolean).join("-") || null;
  const refPorUuid = new Map(
    facturas.filter((f) => f.uuid).map((f) => [normalizarUuid(f.uuid!), { ref: ref(f), id: f.id, fecha: f.fecha, total: f.total }])
  );
  const fechaCorta = (d: Date) => d.toISOString().slice(0, 10).split("-").reverse().join("/");

  const movimientos: Mov[] = [];
  // Lo aplicado por REP a cada factura, en orden de fecha de pago y topado a su total.
  const repPorFactura = new Map<string, number>();
  for (const r of reps) {
    const k = normalizarUuid(r.parentUuid);
    const padre = refPorUuid.get(k);
    if (!padre) continue;
    const previo = repPorFactura.get(k) ?? 0;
    const abono = r2(Math.min(Number(r.impPagado ?? 0), Math.max(0, padre.total - previo)));
    if (abono <= 0.005) continue;
    repPorFactura.set(k, r2(previo + abono));
    const fecha = r.fechaPago ?? r.pagoInvoice.fecha;
    const deOtroAnio = padre.fecha.getFullYear() !== fecha.getFullYear();
    movimientos.push({
      fecha,
      tipo: "PAGO_REP",
      referencia: padre.ref,
      invoiceId: r.pagoInvoiceId,
      concepto: `Pago (REP${r.numParcialidad ? ` parcialidad ${r.numParcialidad}` : ""}) de ${padre.ref ?? "factura"}${deOtroAnio ? ` del ${fechaCorta(padre.fecha)}` : ""}`,
      cargo: 0,
      abono,
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
          concepto: `${verboBanco} conciliado en banco de ${ref(f) ?? "factura"} (sin REP)`,
          cargo: 0, abono: excedente,
        });
      }
    } else {
      // PUE: liquidada en su emisión (misma regla de evidencia que la cartera),
      // salvo lo que un REP dice haber pagado después: eso queda en su fecha.
      const implicito = r2(f.total - rep);
      if (implicito > 0.005) {
        movimientos.push({
          fecha: f.fecha, tipo: "PAGO_PUE", referencia: ref(f), invoiceId: f.id,
          concepto: `Pago de ${ref(f) ?? "factura"} (PUE — una sola exhibición)`,
          cargo: 0, abono: implicito,
        });
      }
    }
  }

  // Misma fecha: primero el CARGO y luego sus abonos, para que el saldo
  // corrido nunca «baje» antes de que exista la factura que se paga.
  movimientos.sort((a, b) => +a.fecha - +b.fecha || b.cargo - a.cargo);

  const saldoAnterior = r2(
    movimientos.filter((m) => m.fecha < inicio).reduce((s, m) => s + m.cargo - m.abono, 0)
  );
  const delEjercicio = movimientos.filter((m) => m.fecha >= inicio && m.fecha < fin);

  let saldo = saldoAnterior;
  const conSaldo = delEjercicio.map((m) => {
    saldo = r2(saldo + m.cargo - m.abono);
    return { ...m, cargo: r2(m.cargo), abono: r2(m.abono), saldo };
  });

  const { companyId: _companyId, ...contactoPublico } = contacto;
  return NextResponse.json({
    contacto: contactoPublico,
    direccion,
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
