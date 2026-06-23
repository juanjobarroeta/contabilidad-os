/**
 * GET /api/construccion/cfdis?companyId=…&tipo=RECIBIDA|EMITIDA[&q=…]
 *
 * Surfaces the company's CFDIs (fiscal-core `Invoice` rows, downloaded by the
 * SAT sync) to the bartiz Facturas inbox. The counterparty is stored as the
 * invoice's `customer` regardless of direction, so:
 *   RECIBIDA (we are receptor → EGRESO): emisor = customer (proveedor)
 *   EMITIDA  (we are emisor  → INGRESO): receptor = customer (cliente)
 *
 * For RECIBIDA we resolve the construcción Supplier by emisor RFC so the link
 * step (later) has a supplierId to work with. Match suggestions / confirmed
 * links (vincular / candidatos / ignorar) are a follow-up — for now we derive a
 * minimal matchEstado from data we already have (estimación link, payment).
 *
 * See BACKEND-CFDI.md (bartiz) for the full contract.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

// SAT tipoComprobante shown as a label in the UI. Our Invoice.tipo encodes our
// accounting direction; for I/E both sides see an "Ingreso" comprobante.
const TIPO_COMPROBANTE: Record<string, string> = {
  INGRESO: "I",
  EGRESO: "I",
  NOMINA: "N",
  PAGO: "P",
  TRASLADO: "T",
};

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const tipo = url.searchParams.get("tipo"); // RECIBIDA | EMITIDA
  const q = url.searchParams.get("q")?.trim();
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, razonSocial: true },
  });

  const where: Record<string, unknown> = {
    companyId,
    uuid: { not: null }, // only stamped CFDIs (drafts have no folio fiscal)
  };
  if (tipo === "RECIBIDA") where.tipo = "EGRESO";
  else if (tipo === "EMITIDA") where.tipo = "INGRESO";
  if (q) {
    where.OR = [
      { uuid: { contains: q, mode: "insensitive" } },
      { folio: { contains: q, mode: "insensitive" } },
      { customer: { razonSocial: { contains: q, mode: "insensitive" } } },
      { customer: { rfc: { contains: q, mode: "insensitive" } } },
    ];
  }

  const invoices = await prisma.invoice.findMany({
    where,
    include: {
      customer: { select: { id: true, rfc: true, razonSocial: true } },
      estimacion: {
        select: {
          id: true,
          numero: true,
          proyecto: { select: { codigo: true, nombre: true } },
        },
      },
      bankTransactions: { where: { status: "MATCHED" }, select: { monto: true } },
    },
    orderBy: { fecha: "desc" },
    take: 300,
  });

  // Resolve construcción Suppliers by emisor RFC for received CFDIs.
  const emisorRfcs = invoices
    .filter((i) => i.tipo === "EGRESO" && i.customer?.rfc)
    .map((i) => i.customer!.rfc);
  const suppliers = emisorRfcs.length
    ? await prisma.supplier.findMany({
        where: { companyId, rfc: { in: [...new Set(emisorRfcs)] } },
        select: { id: true, rfc: true, razonSocial: true },
      })
    : [];
  const supplierByRfc = new Map(suppliers.map((s) => [s.rfc, s]));

  const out = invoices.map((inv) => {
    const recibida = inv.tipo === "EGRESO";
    const cp = inv.customer;
    const supplier = recibida && cp?.rfc ? supplierByRfc.get(cp.rfc) ?? null : null;

    const matchedAmount = Math.abs(inv.bankTransactions.reduce((s, t) => s + t.monto, 0));
    const paid = inv.total > 0 && matchedAmount >= inv.total - 0.01;

    // Minimal match state until the operational link layer lands.
    let matchEstado = "SIN_VINCULAR";
    let link: { tipo: string; targetId: string; label: string } | null = null;
    if (!recibida && inv.estimacion) {
      matchEstado = "VINCULADA";
      const codigo = inv.estimacion.proyecto?.codigo;
      link = {
        tipo: "ESTIMACION",
        targetId: inv.estimacion.id,
        label: `EST. ${inv.estimacion.numero}${codigo ? ` · ${codigo}` : ""}`,
      };
    } else if (paid) {
      matchEstado = "PAGADA";
    }

    return {
      id: inv.id,
      uuid: inv.uuid,
      serie: inv.serie ?? "",
      folio: inv.folio ?? "",
      tipo: recibida ? "RECIBIDA" : "EMITIDA",
      tipoComprobante: TIPO_COMPROBANTE[inv.tipo] ?? "I",
      emisorRfc: recibida ? cp?.rfc ?? null : company?.rfc ?? null,
      emisorNombre: recibida ? cp?.razonSocial ?? null : company?.razonSocial ?? null,
      receptorRfc: recibida ? company?.rfc ?? null : cp?.rfc ?? null,
      receptorNombre: recibida ? company?.razonSocial ?? null : cp?.razonSocial ?? null,
      fecha: inv.fecha,
      subtotal: inv.subtotal,
      iva: inv.totalImpuestos,
      total: inv.total,
      moneda: inv.moneda,
      estadoSat: inv.status === "CANCELLED" || inv.canceladaAt ? "CANCELADO" : "VIGENTE",
      matchEstado,
      supplierId: supplier?.id ?? null,
      supplier: supplier
        ? { razonSocial: supplier.razonSocial }
        : recibida && cp
          ? { razonSocial: cp.razonSocial }
          : null,
      suggestion: null,
      link,
    };
  });

  return NextResponse.json(out);
});
