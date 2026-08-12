import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { toCsv, type CsvRow } from "@/lib/csv";
import { nombreContraparte, rfcContraparte } from "@/lib/facturas/contraparte";

// GET /api/papeles/retenciones?companyId=xxx&year=2026&month=3[&format=csv]
//
// Papel de trabajo de retenciones del mes. Lista:
//   a) Retenciones que NOS hicieron (ingresos donde el cliente nos retuvo)
//      — típico en honorarios, arrendamiento, servicios profesionales
//   b) Retenciones que HICIMOS (egresos donde le retuvimos al proveedor)
//      — nos vuelven pasivo a pagar al SAT
//
// Por tipo de retención: IVA, ISR (hay otros tipos menos comunes: IEPS,
// retención por compra a persona física, etc., que también agrupamos).
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = parseInt(searchParams.get("year") ?? "");
  const month = parseInt(searchParams.get("month") ?? "");
  const format = searchParams.get("format");

  if (!companyId || isNaN(year) || isNaN(month)) {
    return NextResponse.json({ error: "companyId, year, month requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  const periodo = `${year}-${String(month).padStart(2, "0")}`;

  const [ingresos, egresos, company] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: { customer: { select: { razonSocial: true, rfc: true } }, taxes: true },
      orderBy: { fecha: "asc" },
    }),
    prisma.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: { customer: { select: { razonSocial: true, rfc: true } }, taxes: true },
      orderBy: { fecha: "asc" },
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { rfc: true, razonSocial: true },
    }),
  ]);

  type InvoiceRelation = (typeof ingresos)[number];

  type Row = {
    id: string;
    fecha: string;
    uuid: string | null;
    serie: string | null;
    folio: string | null;
    contraparte: string;
    rfc: string;
    subtotal: number;
    tipoRetencion: "IVA" | "ISR" | "IEPS";
    tasa: number | null;
    importe: number;
  };

  // Retenciones que nos hicieron los clientes (ingresos)
  const retencionesRecibidas: Row[] = [];
  // Retenciones que le hicimos a proveedores (egresos)
  const retencionesEfectuadas: Row[] = [];

  function rowsFromInvoice(inv: InvoiceRelation): Row[] {
    // If InvoiceTax rows exist use those (preferred — exact values per type)
    const taxRows = inv.taxes.filter((t) => t.retencion);
    const rows: Row[] = [];
    if (taxRows.length > 0) {
      for (const t of taxRows) {
        if (t.importe < 0.005) continue;
        rows.push({
          id: inv.id,
          fecha: inv.fecha.toISOString().slice(0, 10),
          uuid: inv.uuid,
          serie: inv.serie,
          folio: inv.folio,
          contraparte: nombreContraparte(inv),
          rfc: rfcContraparte(inv),
          subtotal: inv.subtotal,
          tipoRetencion: (t.tipo as "IVA" | "ISR" | "IEPS") ?? "ISR",
          tasa: inv.subtotal > 0 ? +(t.importe / inv.subtotal).toFixed(4) : null,
          importe: t.importe,
        });
      }
    } else {
      // Fallback: if totalImpuestos is negative, it represents net retenciones.
      // We can't know the split between IVA/ISR without InvoiceTax rows so we
      // label it as ISR (the most common retención) and warn in the footer.
      const ti = inv.totalImpuestos ?? 0;
      if (ti < -0.005) {
        rows.push({
          id: inv.id,
          fecha: inv.fecha.toISOString().slice(0, 10),
          uuid: inv.uuid,
          serie: inv.serie,
          folio: inv.folio,
          contraparte: nombreContraparte(inv),
          rfc: rfcContraparte(inv),
          subtotal: inv.subtotal,
          tipoRetencion: "ISR",
          tasa: inv.subtotal > 0 ? +(-ti / inv.subtotal).toFixed(4) : null,
          importe: -ti,
        });
      }
    }
    return rows;
  }

  for (const inv of ingresos) retencionesRecibidas.push(...rowsFromInvoice(inv));
  for (const inv of egresos) retencionesEfectuadas.push(...rowsFromInvoice(inv));

  const sumBy = (rows: Row[], type: Row["tipoRetencion"]) =>
    rows.filter((r) => r.tipoRetencion === type).reduce((s, r) => s + r.importe, 0);

  const totales = {
    recibidas: {
      isr: sumBy(retencionesRecibidas, "ISR"),
      iva: sumBy(retencionesRecibidas, "IVA"),
      ieps: sumBy(retencionesRecibidas, "IEPS"),
      total: retencionesRecibidas.reduce((s, r) => s + r.importe, 0),
    },
    efectuadas: {
      isr: sumBy(retencionesEfectuadas, "ISR"),
      iva: sumBy(retencionesEfectuadas, "IVA"),
      ieps: sumBy(retencionesEfectuadas, "IEPS"),
      total: retencionesEfectuadas.reduce((s, r) => s + r.importe, 0),
    },
  };

  const payload = {
    periodo,
    company: company ? { rfc: company.rfc, razonSocial: company.razonSocial } : null,
    retencionesRecibidas,
    retencionesEfectuadas,
    totales,
  };

  if (format === "csv") {
    const headers = [
      "Sección",
      "Tipo retención",
      "Fecha",
      "UUID",
      "Serie",
      "Folio",
      "Contraparte",
      "RFC",
      "Subtotal",
      "Tasa",
      "Importe retenido",
    ];

    const section = (label: string, rows: Row[]): CsvRow[] =>
      rows.map((r) => [
        label,
        r.tipoRetencion,
        r.fecha,
        r.uuid ?? "",
        r.serie ?? "",
        r.folio ?? "",
        r.contraparte,
        r.rfc,
        r.subtotal.toFixed(2),
        r.tasa != null ? (r.tasa * 100).toFixed(2) + "%" : "",
        r.importe.toFixed(2),
      ]);

    const rows: CsvRow[] = [
      ...section("Retenciones que nos hicieron (ingresos)", retencionesRecibidas),
      ...section("Retenciones que efectuamos (egresos)", retencionesEfectuadas),
      [],
      ["TOTALES"],
      ["Retenciones recibidas — ISR", "", "", "", "", "", "", "", "", "", totales.recibidas.isr.toFixed(2)],
      ["Retenciones recibidas — IVA", "", "", "", "", "", "", "", "", "", totales.recibidas.iva.toFixed(2)],
      ["Retenciones recibidas — IEPS", "", "", "", "", "", "", "", "", "", totales.recibidas.ieps.toFixed(2)],
      ["Retenciones efectuadas — ISR", "", "", "", "", "", "", "", "", "", totales.efectuadas.isr.toFixed(2)],
      ["Retenciones efectuadas — IVA", "", "", "", "", "", "", "", "", "", totales.efectuadas.iva.toFixed(2)],
      ["Retenciones efectuadas — IEPS", "", "", "", "", "", "", "", "", "", totales.efectuadas.ieps.toFixed(2)],
    ];

    const csv = toCsv(headers, rows);
    const filename = `papel_retenciones_${company?.rfc ?? ""}_${periodo}.csv`;
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  return NextResponse.json(payload);
}
