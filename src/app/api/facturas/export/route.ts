import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { headersDescargaXlsx, toXlsx, type XlsxRow } from "@/lib/export/xlsx";
import { filtrosListaFacturas } from "@/lib/facturas/filtros-lista";

// GET /api/facturas/export?companyId=xxx&tipo=&from=&to=&q=&customerId=
//
// Un LIBRO de Excel con lo que se está viendo en la pantalla de Facturas —
// el mismo filtro que la lista y las tarjetas (lib/facturas/filtros-lista)—
// en dos hojas:
//
//   Facturas   una fila por comprobante, en el orden del export de CFDI del
//              SAT para que el contador no reaprenda columnas, más lo que el
//              SAT no da y aquí sí: desglose de impuestos por tipo, naturaleza
//              fiscal, CFDI relacionado, tipo de cambio.
//   Conceptos  una fila por PARTIDA (InvoiceItem), con la llave de la factura
//              en cada renglón para cruzar con la otra hoja. Antes los
//              conceptos iban aplastados en una celda —«primeros 3», separados
//              por «|»— que ni se filtra ni se suma.
//
// XLSX y no CSV porque los importes salen como NÚMEROS y las fechas como
// FECHAS: un CSV entrega texto y Excel no suma texto (ver lib/export/xlsx).
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const filtros = filtrosListaFacturas(searchParams, companyId);
  const where = { ...filtros.where };
  // Sin tipo, el export excluye canceladas (como el export del propio SAT); la
  // lista las incluye porque el chip «Todas» las cuenta. Es la única
  // diferencia deliberada entre las dos, y aquí queda escrita.
  if (!filtros.tipo) where.status = { not: "CANCELLED" };

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
            unidad: true,
            valorUnitario: true,
            importe: true,
            descuento: true,
            cuentaPredial: true,
          },
        },
        taxes: { select: { tipo: true, factor: true, tasa: true, base: true, importe: true, retencion: true } },
      },
      orderBy: { fecha: "desc" },
      take: 5000,
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { rfc: true, razonSocial: true },
    }),
  ]);

  const n = (v: unknown) => (v == null ? null : Number(v));
  const r2 = (v: number) => Math.round(v * 100) / 100;

  const hFacturas = [
    "Tipo",
    "Tipo SAT",
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
    "Tipo de cambio",
    "Subtotal",
    "Descuento",
    "IVA trasladado",
    "IVA retenido",
    "ISR retenido",
    "IEPS",
    "Impuestos netos (CFDI)",
    "Total",
    "Estado",
    "Naturaleza",
    "CFDI relacionado",
    "Tipo de relación",
    "Conceptos",
    "Notas",
    "Facturapi ID",
  ];
  const hConceptos = [
    "UUID",
    "Fecha",
    "Tipo",
    "Serie",
    "Folio",
    "Contraparte RFC",
    "Contraparte nombre",
    "Clave prod/serv",
    "Descripción",
    "Cantidad",
    "Clave unidad",
    "Unidad",
    "Valor unitario",
    "Descuento",
    "Importe",
    "Cuenta predial",
  ];

  const filasFacturas: XlsxRow[] = [];
  const filasConceptos: XlsxRow[] = [];

  for (const inv of invoices) {
    // Quién es el emisor: si la empresa emite (INGRESO/NOMINA/PAGO) la
    // contraparte es el receptor; si recibe (EGRESO) la contraparte es el
    // emisor. Los EGRESO sincronizados del SAT casi nunca tienen Customer —
    // ahí manda lo que el propio CFDI trae (contraparteRfc/Nombre).
    const isEmisor = inv.tipo === "INGRESO" || inv.tipo === "NOMINA" || inv.tipo === "PAGO";
    const contraparteRfc = inv.customer?.rfc ?? inv.contraparteRfc ?? "";
    const contraparteNombre = inv.customer?.razonSocial ?? inv.contraparteNombre ?? "";
    const emisorRfc = isEmisor ? company?.rfc ?? "" : contraparteRfc;
    const emisorNombre = isEmisor ? company?.razonSocial ?? "" : contraparteNombre;
    const receptorRfc = isEmisor ? contraparteRfc : company?.rfc ?? "";
    const receptorNombre = isEmisor ? contraparteNombre : company?.razonSocial ?? "";

    // Desglose por tipo desde InvoiceTax (cuando el XML lo trae). El neto del
    // CFDI (totalImpuestos) va aparte y siempre: es lo que suma el comprobante
    // aunque no haya desglose.
    let ivaTras = 0, ivaRet = 0, isrRet = 0, ieps = 0;
    for (const t of inv.taxes) {
      const imp = Number(t.importe);
      if (t.tipo === "IVA") { if (t.retencion) ivaRet += imp; else ivaTras += imp; }
      else if (t.tipo === "ISR") { if (t.retencion) isrRet += imp; }
      else if (t.tipo === "IEPS") { if (!t.retencion) ieps += imp; }
    }

    filasFacturas.push([
      inv.tipo,
      inv.tipoSat ?? "",
      inv.fecha,
      inv.serie ?? "",
      inv.folio ?? "",
      inv.uuid ?? "",
      emisorRfc,
      emisorNombre,
      receptorRfc,
      receptorNombre,
      isEmisor ? inv.customer?.regimenFiscal ?? "" : "",
      inv.usoCfdi,
      inv.formaPago,
      inv.metodoPago,
      inv.moneda,
      n(inv.tipoCambio),
      r2(Number(inv.subtotal)),
      r2(Number(inv.descuento ?? 0)),
      r2(ivaTras),
      r2(ivaRet),
      r2(isrRet),
      r2(ieps),
      r2(Number(inv.totalImpuestos)),
      r2(Number(inv.total)),
      inv.status,
      inv.naturaleza ?? "",
      inv.cfdiRelacionadoUuid ?? "",
      inv.tipoRelacion ?? "",
      inv.items.length,
      inv.notas ?? "",
      inv.facturapiId ?? "",
    ]);

    for (const it of inv.items) {
      filasConceptos.push([
        inv.uuid ?? "",
        inv.fecha,
        inv.tipo,
        inv.serie ?? "",
        inv.folio ?? "",
        contraparteRfc,
        contraparteNombre,
        it.claveProdServ,
        it.descripcion,
        n(it.cantidad),
        it.claveUnidad,
        it.unidad ?? "",
        n(it.valorUnitario),
        n(it.descuento),
        n(it.importe),
        it.cuentaPredial ?? "",
      ]);
    }
  }

  const libro = toXlsx([
    {
      nombre: "Facturas",
      headers: hFacturas,
      rows: filasFacturas,
      anchos: [9, 8, 11, 7, 9, 38, 14, 32, 14, 32, 8, 8, 8, 8, 7, 8, 13, 11, 13, 12, 12, 10, 13, 13, 10, 11, 38, 8, 9, 30, 26],
    },
    {
      nombre: "Conceptos",
      headers: hConceptos,
      rows: filasConceptos,
      anchos: [38, 11, 9, 7, 9, 14, 32, 12, 60, 10, 8, 10, 13, 11, 13, 14],
    },
  ]);

  // Nombre: empresa, filtro y fecha de descarga.
  const hoy = new Date().toISOString().slice(0, 10);
  const partes = [
    "facturas",
    company?.rfc ?? "",
    filtros.tipo?.toLowerCase() ?? "",
    filtros.fecha?.gte ? filtros.fecha.gte.toISOString().slice(0, 10) : "",
    filtros.fecha?.lte ? filtros.fecha.lte.toISOString().slice(0, 10) : "",
    hoy,
  ].filter(Boolean);
  const filename = partes.join("_") + ".xlsx";

  return new NextResponse(new Uint8Array(libro), { status: 200, headers: headersDescargaXlsx(filename) });
}
