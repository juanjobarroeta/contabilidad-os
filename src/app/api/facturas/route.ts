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
});

// GET /api/facturas?companyId=xxx
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

  const invoices = await prisma.invoice.findMany({
    where: { companyId },
    include: { customer: true, items: true },
    orderBy: { fecha: "desc" },
    take: 50,
  });

  return NextResponse.json(invoices);
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

  const { companyId, customerId, formaPago, metodoPago, usoCfdi, items, notes } = parsed.data;

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
