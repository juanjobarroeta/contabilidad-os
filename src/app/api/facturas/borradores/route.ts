import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import { assertPuedeEscribir } from "@/lib/subscription";
import { createDraftInvoice, type StampInput } from "@/lib/facturas/stamp";
import { signDraftToken, publicBaseUrl, TTL_CLIENTE_MS } from "@/lib/facturas/file-token";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// Prefacturas (borradores de CFDI).
//
// POST /api/facturas/borradores — crea el draft en Facturapi (su PDF sale con
// marca BORRADOR y NO consume timbre) y lo persiste con el payload completo
// para poder timbrarlo después. Devuelve el enlace firmado del PDF (7 días)
// listo para compartir con el cliente.
//
// GET /api/facturas/borradores?companyId= — lista las PENDIENTES con cliente
// y enlace de PDF vigente.
// ─────────────────────────────────────────────────────────────────────────────

const itemSchema = z.object({
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

const createSchema = z.object({
  companyId: z.string().min(1),
  customerId: z.string().min(1),
  formaPago: z.string().min(1),
  metodoPago: z.enum(["PUE", "PPD"]),
  usoCfdi: z.string().min(1),
  items: z.array(itemSchema).min(1),
  notes: z.string().optional(),
  global: z
    .object({
      periodicity: z.enum(["day", "week", "fortnight", "month", "two_months"]),
      months: z.string(),
      year: z.number(),
    })
    .optional(),
});

function pdfUrlCliente(companyId: string, draftId: string): string {
  const token = signDraftToken(companyId, draftId, TTL_CLIENTE_MS);
  return `${publicBaseUrl()}/api/facturas/draft/${draftId}/pdf?companyId=${companyId}&token=${token}`;
}

export async function POST(req: Request) {
  try {
    const parsed = createSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Datos inválidos" },
        { status: 400 }
      );
    }
    const input = parsed.data as StampInput;
    const { user } = await requireWriter(input.companyId, req);
    await assertPuedeEscribir(user.id);

    const draft = await createDraftInvoice(input);
    if (!draft.ok) {
      return NextResponse.json(
        { error: draft.error, needsReconfigure: draft.needsReconfigure },
        { status: draft.status }
      );
    }

    // Total estimado con IVA por partida (el definitivo lo fija el CFDI).
    const total = +input.items
      .reduce((s, it) => {
        const base = it.quantity * it.product.price;
        const iva = (it.product.taxes ?? []).reduce(
          (t, tax) => t + (tax.withholding ? -1 : 1) * base * tax.rate,
          0
        );
        return s + base + iva;
      }, 0)
      .toFixed(2);

    const borrador = await prisma.facturaBorrador.create({
      data: {
        companyId: input.companyId,
        customerId: input.customerId,
        draftId: draft.draftId,
        payload: JSON.parse(JSON.stringify(input)),
        total,
      },
    });

    registrarBitacora({
      companyId: input.companyId,
      userId: user.id,
      actorEmail: user.email,
      accion: "factura.prefactura.crear",
      entidad: "FacturaBorrador",
      entidadId: borrador.id,
      detalle: { draftId: draft.draftId, total },
      req,
    });

    return NextResponse.json(
      {
        ok: true,
        id: borrador.id,
        draftId: draft.draftId,
        total,
        pdfUrl: pdfUrlCliente(input.companyId, draft.draftId),
      },
      { status: 201 }
    );
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const companyId = url.searchParams.get("companyId");
    if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
    await requireMembership(companyId, undefined, req);

    const borradores = await prisma.facturaBorrador.findMany({
      where: { companyId, status: "PENDIENTE" },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { customer: { select: { razonSocial: true, rfc: true, email: true } } },
    });

    return NextResponse.json(
      borradores.map((b) => ({
        id: b.id,
        draftId: b.draftId,
        cliente: b.customer.razonSocial,
        rfc: b.customer.rfc,
        emailCliente: b.customer.email,
        total: b.total,
        enviadaAt: b.enviadaAt,
        createdAt: b.createdAt,
        pdfUrl: pdfUrlCliente(companyId, b.draftId),
      }))
    );
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
