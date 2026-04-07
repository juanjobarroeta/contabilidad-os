import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getFacturapiClient } from "@/lib/facturapi";
import { z } from "zod";

const invoiceItemSchema = z.object({
  quantity: z.number().positive(),
  product: z.object({
    description: z.string(),
    product_key: z.string(),
    price: z.number().positive(),
    unit_key: z.string().default("E48"),
    tax_included: z.boolean().default(false),
    taxes: z
      .array(
        z.object({
          type: z.string(),
          rate: z.number(),
          factor: z.string(),
          withholding: z.boolean().default(false),
        })
      )
      .optional(),
  }),
});

const createInvoiceSchema = z.object({
  companyId: z.string(),
  customerId: z.string(),
  formaPago: z.string(),
  metodoPago: z.enum(["PUE", "PPD"]),
  usoCfdi: z.string(),
  items: z.array(invoiceItemSchema),
  notes: z.string().optional(),
  global: z.object({
    periodicity: z.enum(["day", "week", "fortnight", "month", "two_months"]),
    months: z.string(),
    year: z.number(),
  }).optional(),
});

// GET /api/facturas?companyId=xxx&q=search&tipo=EGRESO&take=20
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json([], { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  // Verify membership
  const membership = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId } },
  });
  if (!membership) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const q = searchParams.get("q")?.trim();
  const tipo = searchParams.get("tipo");
  const take = Math.min(parseInt(searchParams.get("take") ?? "50"), 200);
  const unmatchedOnly = searchParams.get("unmatchedOnly") === "true";

  const where: import("@prisma/client").Prisma.InvoiceWhereInput = { companyId };
  if (tipo && ["INGRESO", "EGRESO", "TRASLADO", "NOMINA", "PAGO"].includes(tipo)) {
    where.tipo = tipo as "INGRESO" | "EGRESO" | "TRASLADO" | "NOMINA" | "PAGO";
  }
  if (q) {
    where.OR = [
      { uuid: { contains: q, mode: "insensitive" } },
      { folio: { contains: q, mode: "insensitive" } },
      { notas: { contains: q, mode: "insensitive" } },
      { customer: { razonSocial: { contains: q, mode: "insensitive" } } },
      { customer: { rfc: { contains: q, mode: "insensitive" } } },
    ];
  }

  // When unmatchedOnly, pull extra rows and filter in code since aggregating
  // against bankTransactions requires either raw SQL or a two-step query.
  const fetchTake = unmatchedOnly ? Math.min(take * 4, 400) : take;

  const invoices = await prisma.invoice.findMany({
    where,
    include: {
      customer: true,
      items: true,
      bankTransactions: {
        where: { status: "MATCHED" },
        select: { id: true, monto: true },
      },
    },
    orderBy: { fecha: "desc" },
    take: fetchTake,
  });

  const enriched = invoices.map((inv) => {
    const matchedAmount = inv.bankTransactions.reduce(
      (s, tx) => s + Math.abs(tx.monto),
      0
    );
    const fullyMatched = matchedAmount >= inv.total - 0.01;
    // bankTransactions was only loaded to compute this — strip from payload.
    const { bankTransactions: _bts, ...rest } = inv;
    void _bts;
    return { ...rest, matchedAmount, fullyMatched };
  });

  const filtered = unmatchedOnly ? enriched.filter((i) => !i.fullyMatched) : enriched;

  return NextResponse.json(filtered.slice(0, take));
}

// POST /api/facturas — emit CFDI via Facturapi
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const parsed = createInvoiceSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { companyId, customerId, formaPago, metodoPago, usoCfdi, items, notes, global: globalInfo } = parsed.data;

  // Verify membership with at least ACCOUNTANT role
  const membership = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId } },
  });
  if (!membership || membership.role === "VIEWER") {
    return NextResponse.json({ error: "Sin permisos" }, { status: 403 });
  }

  // Get company + customer
  const [company, customer] = await Promise.all([
    prisma.company.findUnique({ where: { id: companyId } }),
    prisma.customer.findUnique({ where: { id: customerId } }),
  ]);

  if (!company?.facturapiApiKey) {
    return NextResponse.json(
      { error: "Configura la clave de Facturapi en la empresa antes de timbrar" },
      { status: 422 }
    );
  }
  if (!customer?.facturapiId) {
    return NextResponse.json(
      { error: "El cliente no está sincronizado con Facturapi" },
      { status: 422 }
    );
  }

  const facturapi = getFacturapiClient(company.facturapiApiKey);

  // CFDI 4.0: Información Global is mandatory when RFC = XAXX010101000
  const isPublicoGeneral = customer.rfc === "XAXX010101000";
  let resolvedGlobal = globalInfo;
  if (isPublicoGeneral && !resolvedGlobal) {
    // Auto-build a sensible default: current month, monthly periodicity
    const now = new Date();
    resolvedGlobal = {
      periodicity: "month",
      months: String(now.getMonth() + 1).padStart(2, "0"),
      year: now.getFullYear(),
    };
  }

  console.log("[facturas] isPublicoGeneral:", isPublicoGeneral, "global:", resolvedGlobal);

  // Create invoice in Facturapi
  const facturapiInvoice = await facturapi.invoices.create({
    customer: customer.facturapiId,
    payment_form: formaPago,
    payment_method: metodoPago,
    use: usoCfdi,
    items: items.map((item) => ({
      quantity: item.quantity,
      product: item.product,
    })),
    ...(notes && { pdf_custom_section: notes }),
    ...(resolvedGlobal && { global: resolvedGlobal }),
  });

  // Compute totals
  const subtotal = facturapiInvoice.subtotal ?? 0;
  const total = facturapiInvoice.total ?? 0;
  const totalImpuestos = total - subtotal;

  // Persist to DB
  const invoice = await prisma.invoice.create({
    data: {
      companyId,
      customerId,
      tipo: "INGRESO",
      fecha: new Date(),
      formaPago,
      metodoPago,
      usoCfdi,
      subtotal,
      total,
      totalImpuestos,
      notas: notes,
      status: "STAMPED",
      uuid: facturapiInvoice.uuid,
      facturapiId: facturapiInvoice.id,
      items: {
        create: items.map((item) => ({
          cantidad: item.quantity,
          claveUnidad: item.product.unit_key ?? "E48",
          claveProdServ: item.product.product_key,
          descripcion: item.product.description,
          valorUnitario: item.product.price,
          importe: item.quantity * item.product.price,
        })),
      },
    },
    include: { items: true, customer: true },
  });

  return NextResponse.json(invoice, { status: 201 });
}
