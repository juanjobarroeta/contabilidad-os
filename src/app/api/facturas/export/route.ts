import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { toCsv, type CsvRow } from "@/lib/csv";
import { whereBusquedaFacturas } from "@/lib/facturas/busqueda";

// GET /api/facturas/export?companyId=xxx&tipo=&from=&to=&q=
//
// Returns a CSV file with one row per factura, matching the columns a
// contador uses when they download from SAT + paste into Excel. Contador
// pain point: they want to verify auto-classification + conciliación by
// eyeballing the raw list. This is the trust builder.
//
// Columns are intentionally named in Spanish and ordered like the SAT
// "Comprobantes Fiscales Digitales por Internet" export so contadores
// don't need to relearn column positions.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const tipo = searchParams.get("tipo"); // INGRESO | EGRESO | NOMINA | PAGO | CANCELLED
  const fromStr = searchParams.get("from"); // ISO date
  const toStr = searchParams.get("to");
  // La misma búsqueda que la lista: el Excel exporta lo que se está viendo,
  // no todas las facturas del periodo (antes ignoraba `q`).
  const q = searchParams.get("q")?.trim() ?? "";

  const where: import("@prisma/client").Prisma.InvoiceWhereInput = { companyId };

  // Special value: "CANCELLED" filter returns only cancelled CFDIs regardless of tipo.
  if (tipo === "CANCELLED") {
    where.status = "CANCELLED";
  } else {
    // Exclude cancelled from normal exports to mirror what SAT's own export does
    where.status = { not: "CANCELLED" };
    if (tipo && ["INGRESO", "EGRESO", "NOMINA", "PAGO", "TRASLADO"].includes(tipo)) {
      where.tipo = tipo as "INGRESO" | "EGRESO" | "NOMINA" | "PAGO" | "TRASLADO";
    }
  }

  if (fromStr || toStr) {
    where.fecha = {};
    if (fromStr) where.fecha.gte = new Date(fromStr);
    if (toStr) where.fecha.lte = new Date(toStr);
  }
  const busqueda = whereBusquedaFacturas(q);
  if (busqueda) where.AND = busqueda.AND;

  const [invoices, company] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: {
        customer: { select: { rfc: true, razonSocial: true, regimenFiscal: true } },
        items: {
          select: {
            claveProdServ: true,
            descripcion: true,
            cantidad: true,
            claveUnidad: true,
            valorUnitario: true,
            importe: true,
            descuento: true,
          },
        },
      },
      orderBy: { fecha: "desc" },
      take: 5000,
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { rfc: true, razonSocial: true },
    }),
  ]);

  const headers = [
    "Tipo",
    "Fecha",
    "Serie",
    "Folio",
    "UUID",
    "Emisor RFC",
    "Emisor nombre",
    "Receptor RFC",
    "Receptor nombre",
    "Régimen receptor",
    "Uso CFDI",
    "Forma de pago",
    "Método de pago",
    "Moneda",
    "Subtotal",
    "Descuento",
    "IVA trasladado",
    "IVA/ISR retenido (neto)",
    "Total",
    "Estado",
    "Conceptos (primer 3)",
    "Notas",
    "Facturapi ID",
  ];

  const rows: CsvRow[] = invoices.map((inv) => {
    // Deducir quién es el emisor: si la empresa es el emisor, usamos sus datos;
    // si la empresa es el receptor (CFDI recibido), el emisor es el "customer"
    // que en ese caso representa al proveedor.
    const isEmisor = inv.tipo === "INGRESO" || inv.tipo === "NOMINA" || inv.tipo === "PAGO";
    const emisorRfc = isEmisor ? company?.rfc : inv.customer?.rfc;
    const emisorNombre = isEmisor ? company?.razonSocial : inv.customer?.razonSocial;
    const receptorRfc = isEmisor ? inv.customer?.rfc : company?.rfc;
    const receptorNombre = isEmisor ? inv.customer?.razonSocial : company?.razonSocial;

    // Split totalImpuestos into positive (trasladado) and negative (retenido)
    // portions. Our schema stores the net; anything positive is IVA cobrado,
    // anything negative is retenciones on the contador's side.
    const totalImpuestos = Number(inv.totalImpuestos);
    const ivaTrasladado = totalImpuestos > 0 ? totalImpuestos : 0;
    const retenidoNeto = totalImpuestos < 0 ? -totalImpuestos : 0;

    const conceptos = inv.items
      .slice(0, 3)
      .map((it) => `[${it.claveProdServ}] ${it.descripcion}`)
      .join(" | ");

    return [
      inv.tipo,
      inv.fecha.toISOString().slice(0, 10),
      inv.serie ?? "",
      inv.folio ?? "",
      inv.uuid ?? "",
      emisorRfc ?? "",
      emisorNombre ?? "",
      receptorRfc ?? "",
      receptorNombre ?? "",
      isEmisor ? (inv.customer?.regimenFiscal ?? "") : "",
      inv.usoCfdi,
      inv.formaPago,
      inv.metodoPago,
      inv.moneda,
      inv.subtotal.toFixed(2),
      (inv.descuento ?? 0).toFixed(2),
      ivaTrasladado.toFixed(2),
      retenidoNeto.toFixed(2),
      inv.total.toFixed(2),
      inv.status,
      conceptos,
      inv.notas ?? "",
      inv.facturapiId ?? "",
    ];
  });

  const csv = toCsv(headers, rows);

  // Build filename — include company RFC, filters, and current date
  const filenameParts: string[] = ["facturas", company?.rfc ?? ""];
  if (tipo) filenameParts.push(tipo.toLowerCase());
  if (fromStr) filenameParts.push(fromStr);
  if (toStr) filenameParts.push(toStr);
  if (q) filenameParts.push(q.replace(/[^\w.-]+/g, "-").slice(0, 40));
  const filename =
    filenameParts.filter(Boolean).join("_") + ".csv";

  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
