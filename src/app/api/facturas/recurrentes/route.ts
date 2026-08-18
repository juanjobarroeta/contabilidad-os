import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireWriter } from "@/lib/authz";
import { assertPuedeEscribir } from "@/lib/subscription";
import { registrarBitacora } from "@/lib/audit";
import { siguienteEmision, type Periodicidad } from "@/lib/facturas/recurrentes";
import type { StampInput } from "@/lib/facturas/stamp";

// ─────────────────────────────────────────────────────────────────────────────
// Series de facturación recurrente.
//
// GET  /api/facturas/recurrentes?companyId= — lista con su cliente.
// POST /api/facturas/recurrentes            — da de alta una serie.
//
// La serie guarda el MISMO payload que una prefactura manual (StampInput), así
// el cron reusa createDraftInvoice y no existe una segunda forma de armar un
// CFDI que pueda divergir de la primera.
// ─────────────────────────────────────────────────────────────────────────────

const PERIODICIDADES = [
  "SEMANAL",
  "MENSUAL",
  "BIMESTRAL",
  "TRIMESTRAL",
  "SEMESTRAL",
  "ANUAL",
] as const;

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
    local_taxes: z
      .array(
        z.object({
          type: z.string(),
          rate: z.number(),
          withholding: z.boolean().default(false),
          base: z.number().optional(),
        })
      )
      .optional(),
  }),
});

const createSchema = z.object({
  companyId: z.string().min(1),
  customerId: z.string().min(1),
  nombre: z.string().min(1).max(120),
  periodicidad: z.enum(PERIODICIDADES),
  /** Día del mes al que se ancla la serie. Se ignora en SEMANAL. */
  diaMes: z.number().int().min(1).max(31),
  /** Primera emisión, `YYYY-MM-DD`. */
  inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Opcional, `YYYY-MM-DD`: deja de generar después de esta fecha. */
  fin: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  formaPago: z.string().min(1),
  metodoPago: z.enum(["PUE", "PPD"]),
  usoCfdi: z.string().min(1),
  items: z.array(itemSchema).min(1),
  notes: z.string().optional(),
});

/** Total estimado con IVA y retenciones — mismo cálculo que la prefactura. */
function totalEstimado(items: z.infer<typeof itemSchema>[]): number {
  return +items
    .reduce((s, it) => {
      const base = it.quantity * it.product.price;
      const iva = (it.product.taxes ?? []).reduce(
        (t, tax) => t + (tax.withholding ? -1 : 1) * base * tax.rate,
        0
      );
      const local = (it.product.local_taxes ?? []).reduce(
        (t, tax) => t + (tax.withholding ? -1 : 1) * (tax.base ?? base) * tax.rate,
        0
      );
      return s + base + iva + local;
    }, 0)
    .toFixed(2);
}

export async function GET(req: Request) {
  try {
    const companyId = new URL(req.url).searchParams.get("companyId");
    if (!companyId) {
      return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
    }
    await requireMembership(companyId);

    const series = await prisma.facturaRecurrente.findMany({
      where: { companyId },
      select: {
        id: true,
        nombre: true,
        total: true,
        periodicidad: true,
        diaMes: true,
        proximaEmision: true,
        fin: true,
        activa: true,
        generadas: true,
        ultimaEmision: true,
        customer: { select: { razonSocial: true, rfc: true } },
      },
      // Las activas primero y, dentro de ellas, la que toca antes: la lista se
      // lee como una agenda, no como un archivo.
      orderBy: [{ activa: "desc" }, { proximaEmision: "asc" }],
    });

    return NextResponse.json({ series });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
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
    const d = parsed.data;
    const { user } = await requireWriter(d.companyId, req);
    await assertPuedeEscribir(user.id);

    // El cliente debe existir Y pertenecer a la empresa: sin esta comprobación
    // un customerId de otra empresa quedaría amarrado a esta serie.
    const customer = await prisma.customer.findFirst({
      where: { id: d.customerId, companyId: d.companyId },
      select: { id: true },
    });
    if (!customer) {
      return NextResponse.json({ error: "Cliente no encontrado" }, { status: 404 });
    }

    const inicio = new Date(`${d.inicio}T00:00:00.000Z`);
    const fin = d.fin ? new Date(`${d.fin}T00:00:00.000Z`) : null;
    if (fin && fin.getTime() < inicio.getTime()) {
      return NextResponse.json({ error: "El fin no puede ser antes del inicio" }, { status: 400 });
    }

    // La primera emisión es la fecha de inicio tal cual; a partir de ahí manda
    // el ancla. Si el inicio ya pasó, el cron la toma en su próxima corrida.
    const payload: StampInput = {
      companyId: d.companyId,
      customerId: d.customerId,
      formaPago: d.formaPago,
      metodoPago: d.metodoPago,
      usoCfdi: d.usoCfdi,
      items: d.items as StampInput["items"],
      ...(d.notes ? { notes: d.notes } : {}),
    };

    const serie = await prisma.facturaRecurrente.create({
      data: {
        companyId: d.companyId,
        customerId: d.customerId,
        nombre: d.nombre,
        payload: JSON.parse(JSON.stringify(payload)),
        total: totalEstimado(d.items),
        periodicidad: d.periodicidad,
        diaMes: d.diaMes,
        proximaEmision: inicio,
        fin,
      },
      select: { id: true, nombre: true, proximaEmision: true },
    });

    registrarBitacora({
      companyId: d.companyId,
      userId: user.id,
      actorEmail: user.email,
      accion: "factura.recurrente.crear",
      entidad: "FacturaRecurrente",
      entidadId: serie.id,
      detalle: { nombre: d.nombre, periodicidad: d.periodicidad, inicio: d.inicio },
      req,
    });

    return NextResponse.json({
      ok: true,
      serie,
      // Útil para confirmar en la UI: "la siguiente después de ésta sería…".
      siguienteTrasLaPrimera: siguienteEmision(
        inicio,
        d.periodicidad as Periodicidad,
        d.diaMes
      ),
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
