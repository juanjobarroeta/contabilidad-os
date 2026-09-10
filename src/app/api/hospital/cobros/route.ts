/**
 * GET  /api/hospital/cobros?companyId=…[&desde&hasta&estado&afiliacionId&episodioId]
 *      → { cobros: [...], corte: { enCaja, enTransito, total, contracargos, … } }
 * POST /api/hospital/cobros { companyId, fecha, monto, formaPago, episodioId?|invoiceId?|depositoId?,
 *      afiliacionId?, autorizacion?, marca?, tipoTarjeta?, ultimos4?, referencia?, notas?, permitirDuplicado? }
 *      → 201 cobro
 *
 * El cobro con tarjeta NO se guarda sin los datos del voucher: sin ellos nadie
 * lo va a poder casar contra el estado de cuenta del adquirente, y para cuando
 * se concilie ya no hay a quién preguntarle. Una recaptura con la misma
 * (afiliación, día, monto, autorización) se rechaza con 409 salvo que el
 * cajero confirme que de verdad son dos cobros. Ver src/lib/hospital/cobros.ts.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, dinero, error, errorZod, fechaSchema, rangoDeQuery } from "@/lib/hospital/http";
import { FORMAS_PAGO_COBRO, MARCAS, TIPOS_TARJETA, cobroResumen, corteDeCaja, crearCobro } from "@/lib/hospital/cobros";

const ESTADOS = ["COBRADO", "DEPOSITADO", "CONTRACARGADO", "RECUPERADO", "CANCELADO"] as const;

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const rango = rangoDeQuery(searchParams.get("desde"), searchParams.get("hasta"));
  const estado = searchParams.get("estado");
  const afiliacionId = searchParams.get("afiliacionId");
  const episodioId = searchParams.get("episodioId");

  const cobros = await prisma.hospCobro.findMany({
    where: {
      companyId,
      ...(rango ? { fecha: { gte: rango.desde, lt: rango.hasta } } : {}),
      ...(estado && (ESTADOS as readonly string[]).includes(estado) ? { estado: estado as (typeof ESTADOS)[number] } : {}),
      ...(afiliacionId ? { afiliacionId } : {}),
      ...(episodioId ? { episodioId } : {}),
    },
    orderBy: [{ fecha: "desc" }, { createdAt: "desc" }],
    take: 500,
  });

  return NextResponse.json({ cobros: cobros.map(cobroResumen), corte: corteDeCaja(cobros) });
});

const postSchema = z
  .object({
    companyId: z.string().min(1),
    fecha: fechaSchema.nullable().optional(),
    monto: dinero.positive(),
    formaPago: z.enum(FORMAS_PAGO_COBRO),
    episodioId: z.string().nullable().optional(),
    invoiceId: z.string().nullable().optional(),
    depositoId: z.string().nullable().optional(),
    afiliacionId: z.string().nullable().optional(),
    autorizacion: z.string().trim().max(20).nullable().optional(),
    marca: z.enum(MARCAS).nullable().optional(),
    tipoTarjeta: z.enum(TIPOS_TARJETA).nullable().optional(),
    ultimos4: z.string().trim().max(4).nullable().optional(),
    referencia: z.string().trim().max(80).nullable().optional(),
    notas: z.string().trim().max(1000).nullable().optional(),
    permitirDuplicado: z.boolean().optional(),
  })
  .refine((d) => d.episodioId || d.invoiceId || d.depositoId, {
    message: "El cobro tiene que ir a un episodio, a una factura o a un anticipo",
    path: ["episodioId"],
  });

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);

  const cobro = await crearCobro(prisma, {
    companyId: d.companyId,
    fecha: aFecha(d.fecha) ?? new Date(),
    monto: d.monto,
    formaPago: d.formaPago,
    episodioId: d.episodioId ?? null,
    invoiceId: d.invoiceId ?? null,
    depositoId: d.depositoId ?? null,
    afiliacionId: d.afiliacionId ?? null,
    autorizacion: d.autorizacion ?? null,
    marca: d.marca ?? null,
    tipoTarjeta: d.tipoTarjeta ?? null,
    ultimos4: d.ultimos4 ?? null,
    referencia: d.referencia ?? null,
    notas: d.notas ?? null,
    usuarioId: user.id,
    permitirDuplicado: d.permitirDuplicado,
  });

  bitacora(user, req, {
    companyId: d.companyId,
    accion: "hospital.cobro.registrar",
    entidad: "HospCobro",
    entidadId: cobro.id,
    detalle: {
      monto: Number(cobro.monto),
      formaPago: cobro.formaPago,
      afiliacionId: cobro.afiliacionId,
      autorizacion: cobro.autorizacion,
      asentado: !!cobro.asientoAt,
    },
  });
  return NextResponse.json(cobroResumen(cobro), { status: 201 });
});
