import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/salameria/contactos/[id]/estado-cuenta?direccion=CLIENTE|PROVEEDOR&year=2026
//
// El historial completo del contacto, 100 % DOCUMENTAL (derivado de CFDIs) —
// mismo motor que automotriz y hospital, para que un saldo se calcule igual en
// todo el producto:
//   CLIENTE   → lo que le facturamos (INGRESO) y lo que nos ha pagado.
//   PROVEEDOR → lo que nos facturó (EGRESO) y lo que le hemos pagado.
//   CARGO  → factura (no NC, no cancelada).
//   ABONO  → nota de crédito (tipoSat E), REP (complemento de pago, con su
//            FechaPago legal), pago implícito PUE (liquidada en su emisión) y
//            cobro/pago conciliado en banco que exceda lo amparado por REP.
//
// Cada renglón trae su `uuid`: es el CFDI adjunto que se pidió — no una
// referencia suelta, el folio fiscal con el que se busca en el SAT.
//
// Suma lo de la Salamería: los PEDIDOS del módulo ligados a ese contacto, para
// ver en una sola pantalla lo que compró y lo que se le facturó. Sólo lectura.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

type Mov = {
  fecha: Date;
  tipo: "FACTURA" | "NOTA_CREDITO" | "PAGO_REP" | "PAGO_PUE" | "COBRO_BANCO";
  referencia: string | null;
  invoiceId: string | null;
  uuid: string | null;
  facturapiId: string | null;
  concepto: string;
  cargo: number;
  abono: number;
};

export const GET = withAuthz(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id } = await ctx.params;
    const { searchParams } = new URL(req.url);
    const direccion =
      searchParams.get("direccion") === "PROVEEDOR" ? "PROVEEDOR" : "CLIENTE";

    const contacto = await prisma.customer.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        razonSocial: true,
        rfc: true,
        email: true,
        phone: true,
      },
    });
    if (!contacto) throw new AuthzError(404, "Contacto no encontrado");
    await requireMembership(contacto.companyId, undefined, req);
    await requireModule(contacto.companyId, "SALAMERIA", req);

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
        where: {
          companyId: contacto.companyId,
          customerId: id,
          tipo,
          status: { not: "CANCELLED" },
        },
        select: {
          id: true,
          uuid: true,
          serie: true,
          folio: true,
          fecha: true,
          total: true,
          metodoPago: true,
          tipoSat: true,
          // Sólo los timbrados desde la app tienen PDF del PAC; para los de
          // descarga masiva el satélite arma la representación desde el XML.
          facturapiId: true,
          conciliacionDetalles: { select: { montoAsignado: true } },
        },
        orderBy: { fecha: "asc" },
      })
    ).map((f) => ({ ...f, total: Number(f.total) }));

    const uuids = facturas
      .filter((f) => f.tipoSat !== "E")
      .map((f) => f.uuid)
      .filter(Boolean) as string[];
    const reps = uuids.length
      ? await prisma.pagoDoctoRelacionado.findMany({
          where: { parentUuid: { in: variantesUuid(uuids) } },
          select: {
            parentUuid: true,
            impPagado: true,
            numParcialidad: true,
            fechaPago: true,
            pagoInvoiceId: true,
          },
        })
      : [];

    const ref = (f: { serie: string | null; folio: string | null }) =>
      [f.serie, f.folio].filter(Boolean).join("-") || null;
    const refPorUuid = new Map(
      facturas
        .filter((f) => f.uuid)
        .map((f) => [
          normalizarUuid(f.uuid!),
          { ref: ref(f), id: f.id, fecha: f.fecha, uuid: f.uuid },
        ])
    );

    const movimientos: Mov[] = [];
    const repPorFactura = new Map<string, number>();
    for (const r of reps) {
      const k = normalizarUuid(r.parentUuid);
      repPorFactura.set(k, (repPorFactura.get(k) ?? 0) + Number(r.impPagado ?? 0));
      const padre = refPorUuid.get(k);
      movimientos.push({
        fecha: r.fechaPago ?? padre?.fecha ?? new Date(),
        tipo: "PAGO_REP",
        referencia: padre?.ref ?? null,
        invoiceId: r.pagoInvoiceId,
        uuid: padre?.uuid ?? null,
        facturapiId: null,
        concepto: `Pago (REP${r.numParcialidad ? ` parcialidad ${r.numParcialidad}` : ""}) de ${padre?.ref ?? "factura"}`,
        cargo: 0,
        abono: Number(r.impPagado ?? 0),
      });
    }

    for (const f of facturas) {
      if (f.tipoSat === "E") {
        movimientos.push({
          fecha: f.fecha,
          tipo: "NOTA_CREDITO",
          referencia: ref(f),
          invoiceId: f.id,
          uuid: f.uuid,
          facturapiId: f.facturapiId,
          concepto: `Nota de crédito ${ref(f) ?? ""}`.trim(),
          cargo: 0,
          abono: f.total,
        });
        continue;
      }
      movimientos.push({
        fecha: f.fecha,
        tipo: "FACTURA",
        referencia: ref(f),
        invoiceId: f.id,
        uuid: f.uuid,
        facturapiId: f.facturapiId,
        concepto: `Factura ${ref(f) ?? ""}`.trim(),
        cargo: f.total,
        abono: 0,
      });
      const conciliado = f.conciliacionDetalles.reduce(
        (s, d) => s + Math.abs(Number(d.montoAsignado)),
        0
      );
      const rep = f.uuid ? (repPorFactura.get(normalizarUuid(f.uuid)) ?? 0) : 0;
      if (f.metodoPago === "PPD") {
        // Banco por encima de lo amparado con REP (el REP ya tiene su renglón).
        const excedente = Math.max(0, Math.min(conciliado, f.total) - rep);
        if (excedente > 0.01) {
          movimientos.push({
            fecha: f.fecha,
            tipo: "COBRO_BANCO",
            referencia: ref(f),
            invoiceId: f.id,
            uuid: f.uuid,
            facturapiId: f.facturapiId,
            concepto: `${verboBanco} conciliado en banco de ${ref(f) ?? "factura"} (sin REP)`,
            cargo: 0,
            abono: excedente,
          });
        }
      } else {
        // PUE: liquidada en su emisión (misma regla de evidencia que la cartera).
        movimientos.push({
          fecha: f.fecha,
          tipo: "PAGO_PUE",
          referencia: ref(f),
          invoiceId: f.id,
          uuid: f.uuid,
          facturapiId: f.facturapiId,
          concepto: `Pago de ${ref(f) ?? "factura"} (PUE — una sola exhibición)`,
          cargo: 0,
          abono: f.total,
        });
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

    // Los pedidos del módulo ligados a este contacto: lo que compró, al lado
    // de lo que se le facturó.
    const pedidos = await prisma.salPedido.findMany({
      where: {
        companyId: contacto.companyId,
        customerId: id,
        estado: { not: "CARRITO" },
        fecha: { gte: inicio, lt: fin },
      },
      orderBy: { fecha: "desc" },
      select: {
        id: true,
        folio: true,
        fecha: true,
        estado: true,
        total: true,
        pagado: true,
        esPreventa: true,
        invoiceId: true,
      },
      take: 100,
    });

    // Los años con actividad, para que el selector de ejercicio no ofrezca
    // años vacíos ni esconda uno con movimientos.
    const años = [
      ...new Set(movimientos.map((m) => m.fecha.getFullYear())),
    ].sort((a, b) => b - a);

    const { companyId: _companyId, ...contactoPublico } = contacto;
    return NextResponse.json({
      contacto: contactoPublico,
      direccion,
      year,
      años,
      saldoAnterior,
      movimientos: conSaldo,
      pedidos: pedidos.map((p) => ({
        ...p,
        total: Number(p.total),
        pagado: Number(p.pagado),
      })),
      resumen: {
        cargos: r2(delEjercicio.reduce((s, m) => s + m.cargo, 0)),
        abonos: r2(delEjercicio.reduce((s, m) => s + m.abono, 0)),
        saldoFinal: saldo,
        movimientos: conSaldo.length,
      },
    });
  }
);
