import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { toCsv, type CsvRow } from "@/lib/csv";
import { calcularActosDelPeriodo } from "@/lib/fiscal/iva";
import { reconciliacionActiva, pagosConciliadosPorInvoice, pagadaCompleta } from "@/lib/fiscal/conciliacion-pue";

// GET /api/papeles/iva?companyId=xxx&year=2026&month=3[&format=csv]
//
// Papel de trabajo del IVA mensual — detalle por factura de cada renglón
// que alimenta el cálculo que ven los contadores cuando hacen el proceso
// manualmente.
//
// Estructura de respuesta JSON:
//   {
//     periodo: "2026-03",
//     trasladado: Row[],     // INGRESOS: IVA cobrado
//     acreditable: Row[],    // EGRESOS: IVA pagado acreditable
//     retenidoPorClientes: Row[],  // clientes que nos retuvieron IVA
//     retenidoAProveedores: Row[], // nosotros retuvimos IVA a proveedores
//     totales: {
//       trasladado: number,
//       acreditable: number,
//       retenidoPorClientes: number,
//       retenidoAProveedores: number,
//       ivaCargo: number,     // lo que potencialmente debemos
//       saldoFavorAnterior: number,
//       ivaPagar: number,
//       saldoFavorMes: number,
//     },
//   }
//
// Pasa ?format=csv para descarga directa.
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

  // Previous month's declaration for saldo a favor carryover
  const prevPeriodo = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;

  const [ingresos, egresos, prevDecl, company] = await Promise.all([
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
    prisma.taxDeclaration.findFirst({
      where: {
        companyId,
        tipo: "IVA_MENSUAL",
        periodo: prevPeriodo,
        status: { in: ["CALCULATED", "FILED", "PAID"] },
      },
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { rfc: true, razonSocial: true },
    }),
  ]);

  type InvoiceRelation = (typeof ingresos)[number];

  // Extract the IVA components per invoice. When InvoiceTax rows exist we
  // trust them (they match the XML exactly). Otherwise we fall back to
  // totalImpuestos stored at the header.
  function extractIva(inv: InvoiceRelation) {
    const ivaRows = inv.taxes.filter((t) => t.tipo === "IVA");
    if (ivaRows.length > 0) {
      const trasladadoRows = ivaRows.filter((t) => !t.retencion);
      const retenidoRows = ivaRows.filter((t) => t.retencion);
      return {
        trasladado: trasladadoRows.reduce((s, t) => s + t.importe, 0),
        retenido: retenidoRows.reduce((s, t) => s + t.importe, 0),
      };
    }
    // Fallback: totalImpuestos. Positive = net trasladado, negative = net retenido.
    const ti = inv.totalImpuestos ?? 0;
    return {
      trasladado: ti > 0 ? ti : 0,
      retenido: ti < 0 ? -ti : 0,
    };
  }

  type Row = {
    id: string;
    fecha: string;
    uuid: string | null;
    serie: string | null;
    folio: string | null;
    contraparte: string;
    rfc: string;
    subtotal: number;
    tasa: number | null;
    importe: number;
    metodoPago: string;
    /** PUE acreditable sin pago conciliado en banco (cash-basis, Art. 5-I LIVA). */
    sinPagoConciliado?: boolean;
  };

  const trasladado: Row[] = [];
  const retenidoPorClientes: Row[] = [];

  for (const inv of ingresos) {
    const { trasladado: t, retenido: r } = extractIva(inv);
    if (t > 0.005) {
      trasladado.push({
        id: inv.id,
        fecha: inv.fecha.toISOString().slice(0, 10),
        uuid: inv.uuid,
        serie: inv.serie,
        folio: inv.folio,
        contraparte: inv.customer?.razonSocial ?? "—",
        rfc: inv.customer?.rfc ?? "—",
        subtotal: inv.subtotal,
        tasa: inv.subtotal > 0 ? +(t / inv.subtotal).toFixed(4) : null,
        importe: t,
        metodoPago: inv.metodoPago,
      });
    }
    if (r > 0.005) {
      retenidoPorClientes.push({
        id: inv.id,
        fecha: inv.fecha.toISOString().slice(0, 10),
        uuid: inv.uuid,
        serie: inv.serie,
        folio: inv.folio,
        contraparte: inv.customer?.razonSocial ?? "—",
        rfc: inv.customer?.rfc ?? "—",
        subtotal: inv.subtotal,
        tasa: inv.subtotal > 0 ? +(r / inv.subtotal).toFixed(4) : null,
        importe: r,
        metodoPago: inv.metodoPago,
      });
    }
  }

  const acreditable: Row[] = [];
  const retenidoAProveedores: Row[] = [];

  for (const inv of egresos) {
    const { trasladado: t, retenido: r } = extractIva(inv);
    if (t > 0.005) {
      acreditable.push({
        id: inv.id,
        fecha: inv.fecha.toISOString().slice(0, 10),
        uuid: inv.uuid,
        serie: inv.serie,
        folio: inv.folio,
        contraparte: inv.customer?.razonSocial ?? "—",
        rfc: inv.customer?.rfc ?? "—",
        subtotal: inv.subtotal,
        tasa: inv.subtotal > 0 ? +(t / inv.subtotal).toFixed(4) : null,
        importe: t,
        metodoPago: inv.metodoPago,
      });
    }
    if (r > 0.005) {
      retenidoAProveedores.push({
        id: inv.id,
        fecha: inv.fecha.toISOString().slice(0, 10),
        uuid: inv.uuid,
        serie: inv.serie,
        folio: inv.folio,
        contraparte: inv.customer?.razonSocial ?? "—",
        rfc: inv.customer?.rfc ?? "—",
        subtotal: inv.subtotal,
        tasa: inv.subtotal > 0 ? +(r / inv.subtotal).toFixed(4) : null,
        importe: r,
        metodoPago: inv.metodoPago,
      });
    }
  }

  const sum = (rs: Row[]) => rs.reduce((s, r) => s + r.importe, 0);
  const totalTrasladado = sum(trasladado);
  const totalAcreditable = sum(acreditable);
  const totalRetenidoClientes = sum(retenidoPorClientes);
  const totalRetenidoProv = sum(retenidoAProveedores);

  // Proporción de acreditamiento (Art. 5-V LIVA): con actos exentos en el mes,
  // el IVA acreditable sólo procede en gravados/(gravados+exentos). Mismo
  // helper que el motor (computeTaxPosition) para no divergir.
  const actos = calcularActosDelPeriodo(ingresos);
  const acreditableProcedente = +(totalAcreditable * actos.proporcion).toFixed(2);

  // IVA cargo = trasladado - retenidoPorClientes - acreditable procedente
  const ivaCargo = totalTrasladado - totalRetenidoClientes - acreditableProcedente;
  const saldoFavorAnterior = prevDecl?.ivaSaldoFavor ?? 0;
  const cargoFinal = ivaCargo - saldoFavorAnterior;
  const ivaPagar = cargoFinal > 0 ? cargoFinal : 0;
  const saldoFavorMes = cargoFinal < 0 ? -cargoFinal : 0;

  // PUE acreditado sin pago conciliado (cash-basis, Art. 5-I LIVA). El motor
  // asume el PUE pagado al emitirse; sólo si la empresa concilia banco podemos
  // marcar los que no aparecen pagados. Si no concilia, no marcamos nada.
  const reconActiva = await reconciliacionActiva(companyId);
  let ivaPueSinPago = 0;
  let cfdisPueSinPago = 0;
  if (reconActiva) {
    const totalById = new Map(egresos.map((e) => [e.id, e.total]));
    const pueRows = acreditable.filter((r) => r.metodoPago === "PUE");
    const matched = await pagosConciliadosPorInvoice(pueRows.map((r) => r.id));
    for (const r of pueRows) {
      if (!pagadaCompleta(totalById.get(r.id) ?? 0, matched.get(r.id) ?? 0)) {
        r.sinPagoConciliado = true;
        ivaPueSinPago += r.importe;
        cfdisPueSinPago += 1;
      }
    }
  }

  const payload = {
    periodo,
    company: company ? { rfc: company.rfc, razonSocial: company.razonSocial } : null,
    trasladado,
    acreditable,
    retenidoPorClientes,
    retenidoAProveedores,
    totales: {
      trasladado: totalTrasladado,
      acreditable: totalAcreditable,
      proporcionAcreditamiento: actos.proporcion,
      actosGravados: actos.gravados,
      actosExentos: actos.exentos,
      acreditableProcedente,
      retenidoPorClientes: totalRetenidoClientes,
      retenidoAProveedores: totalRetenidoProv,
      ivaCargo,
      saldoFavorAnterior,
      ivaPagar,
      saldoFavorMes,
    },
    reconciliacion: {
      activa: reconActiva,
      ivaPueSinPago: +ivaPueSinPago.toFixed(2),
      cfdisPueSinPago,
    },
  };

  if (format === "csv") {
    const headers = [
      "Sección",
      "Fecha",
      "UUID",
      "Serie",
      "Folio",
      "Contraparte",
      "RFC",
      "Subtotal",
      "Tasa",
      "IVA importe",
      "Método pago",
    ];

    const section = (label: string, rows: Row[]): CsvRow[] =>
      rows.map((r) => [
        label,
        r.fecha,
        r.uuid ?? "",
        r.serie ?? "",
        r.folio ?? "",
        r.contraparte,
        r.rfc,
        r.subtotal.toFixed(2),
        r.tasa != null ? (r.tasa * 100).toFixed(2) + "%" : "",
        r.importe.toFixed(2),
        r.metodoPago,
      ]);

    const rows: CsvRow[] = [
      ...section("IVA trasladado (cobrado)", trasladado),
      ...section("IVA acreditable (pagado)", acreditable),
      ...section("IVA retenido por clientes", retenidoPorClientes),
      ...section("IVA retenido a proveedores", retenidoAProveedores),
      [], // blank row
      ["TOTALES"],
      ["Total IVA trasladado", "", "", "", "", "", "", "", "", totalTrasladado.toFixed(2), ""],
      ["Total IVA acreditable", "", "", "", "", "", "", "", "", totalAcreditable.toFixed(2), ""],
      ...(actos.proporcion < 1
        ? ([
            ["Actos gravados del mes (16%/0%)", "", "", "", "", "", "", "", "", actos.gravados.toFixed(2), ""],
            ["Actos exentos del mes", "", "", "", "", "", "", "", "", actos.exentos.toFixed(2), ""],
            ["Proporción de acreditamiento (Art. 5-V LIVA)", "", "", "", "", "", "", "", "", (actos.proporcion * 100).toFixed(4) + "%", ""],
            ["IVA acreditable procedente", "", "", "", "", "", "", "", "", acreditableProcedente.toFixed(2), ""],
          ] as CsvRow[])
        : []),
      ["Total IVA retenido por clientes", "", "", "", "", "", "", "", "", totalRetenidoClientes.toFixed(2), ""],
      ["Total IVA retenido a proveedores", "", "", "", "", "", "", "", "", totalRetenidoProv.toFixed(2), ""],
      ["IVA a cargo (antes de saldo a favor)", "", "", "", "", "", "", "", "", ivaCargo.toFixed(2), ""],
      ["Saldo a favor anterior", "", "", "", "", "", "", "", "", saldoFavorAnterior.toFixed(2), ""],
      ["IVA A PAGAR", "", "", "", "", "", "", "", "", ivaPagar.toFixed(2), ""],
      ["Saldo a favor del mes", "", "", "", "", "", "", "", "", saldoFavorMes.toFixed(2), ""],
    ];

    const csv = toCsv(headers, rows);
    const filename = `papel_iva_${company?.rfc ?? ""}_${periodo}.csv`;
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
