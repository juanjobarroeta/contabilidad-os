import { NextResponse } from "next/server";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { direccionRep, resumenRep } from "@/lib/facturas/complementos-vista";
import { saldoInsolutoPpd } from "@/lib/facturas/saldo-ppd";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/facturas/[id]/complementos — el puente factura ↔ REP del detalle.
//
// Para una FACTURA (INGRESO/EGRESO): los REPs vigentes que la pagan, con su
// saldo insoluto — lo que el detalle necesita para dejar de decir "Emitir
// complemento de pago" cuando el complemento ya existe.
//
// Para un REP (PAGO): las facturas que paga, con monto y parcialidad por docto.
//
// Las filas van con la MISMA forma que /api/facturas para que el modal pueda
// abrirlas directamente (navegar factura → REP → factura sin salir del detalle).
// ─────────────────────────────────────────────────────────────────────────────

/** Select que reproduce la forma de fila de /api/facturas (sin conciliación). */
const FILA_SELECT = {
  id: true,
  companyId: true,
  uuid: true,
  fecha: true,
  tipo: true,
  metodoPago: true,
  status: true,
  subtotal: true,
  total: true,
  totalImpuestos: true,
  notas: true,
  facturapiId: true,
  naturaleza: true,
  naturalezaRevision: true,
  regimenNomina: true,
  isrRetenidoNomina: true,
  contraparteNombre: true,
  contraparteRfc: true,
  customer: { select: { razonSocial: true, rfc: true } },
  doctosRelacionados: {
    select: { impPagado: true, ivaTrasladado: true, fechaPago: true, numParcialidad: true },
  },
} as const;

type FilaCruda = {
  doctosRelacionados: {
    impPagado: number | null;
    ivaTrasladado: number | null;
    fechaPago: Date | null;
    numParcialidad: number | null;
  }[];
  tipo: string;
} & Record<string, unknown>;

/** Enriquecimiento idéntico al de la lista: montos reales del complemento. */
function filaConPago(inv: FilaCruda) {
  const { doctosRelacionados, ...rest } = inv;
  const esPago = inv.tipo === "PAGO";
  const r = esPago ? resumenRep(doctosRelacionados) : null;
  return {
    ...rest,
    pagoMonto: r?.monto ?? null,
    pagoIva: r?.iva ?? null,
    pagoFecha: r?.fechaPago ?? null,
  };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let userId: string;
  try {
    const u = await requireUser(req);
    userId = u.id;
  } catch (e) {
    const status = e instanceof AuthzError ? e.status : 401;
    return NextResponse.json({ error: "Unauthorized" }, { status });
  }

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    select: {
      id: true,
      companyId: true,
      uuid: true,
      tipo: true,
      total: true,
      metodoPago: true,
      doctosRelacionados: {
        select: {
          parentUuid: true,
          impPagado: true,
          numParcialidad: true,
          impSaldoAnterior: true,
          impSaldoInsoluto: true,
          fechaPago: true,
        },
      },
    },
  });
  if (!invoice) return NextResponse.json({ error: "Factura no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(userId, invoice.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const companyId = invoice.companyId;

  // ── REP → las facturas que paga ─────────────────────────────────────────
  if (invoice.tipo === "PAGO") {
    const uuids = [...new Set(invoice.doctosRelacionados.map((d) => d.parentUuid))];
    const padres = uuids.length
      ? await prisma.invoice.findMany({
          where: { companyId, uuid: { in: variantesUuid(uuids) } },
          select: FILA_SELECT,
        })
      : [];
    const porUuid = new Map(padres.map((p) => [normalizarUuid(p.uuid ?? ""), p]));

    const facturasPagadas = invoice.doctosRelacionados.map((d) => {
      const padre = porUuid.get(normalizarUuid(d.parentUuid));
      return {
        parentUuid: d.parentUuid,
        montoPagado: d.impPagado,
        numParcialidad: d.numParcialidad,
        fechaPago: d.fechaPago,
        // null cuando la factura pagada no está en el sistema (p. ej. anterior
        // al historial descargado) — la fila igual informa monto y UUID.
        factura: padre ? filaConPago(padre as unknown as FilaCruda) : null,
      };
    });

    return NextResponse.json({
      tipo: "PAGO",
      direccion: direccionRep(padres.map((p) => p.tipo)),
      facturasPagadas,
    });
  }

  // ── Factura → los REPs que la pagan ─────────────────────────────────────
  if (!invoice.uuid) return NextResponse.json({ tipo: invoice.tipo, complementos: [], saldo: null });

  const links = await prisma.pagoDoctoRelacionado.findMany({
    where: {
      parentUuid: { in: variantesUuid([invoice.uuid]) },
      pagoInvoice: { companyId, tipo: "PAGO", status: { not: "CANCELLED" } },
    },
    select: {
      impPagado: true,
      numParcialidad: true,
      impSaldoInsoluto: true,
      fechaPago: true,
      pagoInvoice: { select: FILA_SELECT },
    },
    orderBy: [{ fechaPago: "asc" }],
  });

  // Un REP puede traer varios doctos hacia la MISMA factura (raro pero legal);
  // se agrupa por REP para que la lista muestre comprobantes, no nodos.
  const porRep = new Map<string, { fila: FilaCruda; links: typeof links }>();
  for (const l of links) {
    const rep = l.pagoInvoice as unknown as FilaCruda & { id: string };
    const g = porRep.get(rep.id) ?? { fila: rep, links: [] as typeof links };
    g.links.push(l);
    porRep.set(rep.id, g);
  }

  const complementos = [...porRep.values()].map((g) => ({
    rep: filaConPago(g.fila),
    montoPagado: g.links.reduce((s, l) => s + Number(l.impPagado ?? 0), 0),
    parcialidades: g.links.map((l) => l.numParcialidad).filter((n): n is number => n != null),
    fechaPago:
      g.links
        .map((l) => l.fechaPago?.toISOString() ?? null)
        .filter((f): f is string => !!f)
        .sort()[0] ?? null,
  }));

  // Saldo sólo para PPD — en PUE no hay parcialidades que rastrear.
  const saldo =
    invoice.metodoPago === "PPD"
      ? saldoInsolutoPpd(
          Number(invoice.total),
          links.map((l) => ({
            numParcialidad: l.numParcialidad,
            impPagado: l.impPagado === null ? null : Number(l.impPagado),
            impSaldoInsoluto: l.impSaldoInsoluto === null ? null : Number(l.impSaldoInsoluto),
            fechaPago: l.fechaPago,
          }))
        )
      : null;

  return NextResponse.json({ tipo: invoice.tipo, complementos, saldo });
}
