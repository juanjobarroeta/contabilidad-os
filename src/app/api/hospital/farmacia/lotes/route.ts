import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/hospital/farmacia/lotes
//   { companyId, insumoId, lote, caducidad?, cantidad, costoUnitario, invoiceId?, supplierId?, fecha? }
//
// Recepción de compra: «se paga lo que llegó, no lo que se pidió, y el lote
// entra a farmacia con su caducidad desde la recepción». Crea el HospLote
// (existencia = cantidad) y su ENTRADA_COMPRA con loteId; si el mismo
// (insumo, lote) ya existe, le SUMA (existencia += cantidad) con un
// movimiento nuevo. Actualiza el último costo del insumo.
//
// Amarre con el CFDI. La derivación desde el archivo ya pudo escribir una
// ENTRADA_COMPRA para (insumo, CFDI) SIN lote — y el kardex es único por
// (insumo, CFDI, tipo). Por eso, cuando la recepción trae `invoiceId` y esa
// entrada derivada existe sin lote, la recepción la ADOPTA: le pone el lote y
// la cantidad que físicamente llegó (48, no los 60 del CFDI), en vez de
// duplicar la entrada. Un segundo lote del mismo CFDI ya no puede llevar el
// invoiceId (lo tiene el primero): se guarda con la referencia en texto.
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;

const fechaIso = z
  .string()
  .trim()
  .refine((s) => !Number.isNaN(new Date(s).getTime()), "Fecha inválida")
  .transform((s) => new Date(s));

const schema = z.object({
  companyId: z.string().min(1),
  insumoId: z.string().min(1),
  lote: z.string().trim().min(1).max(60),
  caducidad: fechaIso.nullable().optional(),
  cantidad: z.number().positive().max(10_000_000),
  costoUnitario: z.number().min(0).max(100_000_000),
  invoiceId: z.string().min(1).nullable().optional(),
  supplierId: z.string().min(1).nullable().optional(),
  fecha: fechaIso.optional(),
  nota: z.string().trim().max(300).optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Datos inválidos";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const { companyId, insumoId, lote: nombreLote, cantidad, costoUnitario, nota } = parsed.data;
  const caducidad = parsed.data.caducidad ?? null;
  const invoiceId = parsed.data.invoiceId ?? null;
  const supplierId = parsed.data.supplierId ?? null;
  const fecha = parsed.data.fecha ?? new Date();

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const [insumo, invoice, supplier] = await Promise.all([
    prisma.hospInsumo.findFirst({ where: { id: insumoId, companyId }, select: { id: true, clave: true, nombre: true } }),
    invoiceId
      ? prisma.invoice.findFirst({ where: { id: invoiceId, companyId }, select: { id: true, uuid: true, serie: true, folio: true } })
      : Promise.resolve(null),
    supplierId
      ? prisma.supplier.findFirst({ where: { id: supplierId, companyId }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  if (!insumo) throw new AuthzError(404, "Insumo no encontrado");
  if (invoiceId && !invoice) throw new AuthzError(404, "CFDI no encontrado en esta empresa");
  if (supplierId && !supplier) throw new AuthzError(404, "Proveedor no encontrado en esta empresa");

  const usuarioNombre = user.name ?? user.email ?? null;
  const refCfdi = invoice ? ([invoice.serie, invoice.folio].filter(Boolean).join("-") || invoice.uuid || invoice.id) : null;

  const resultado = await prisma.$transaction(async (tx) => {
    const previo = await tx.hospLote.findUnique({
      where: { insumoId_lote: { insumoId, lote: nombreLote } },
      select: { id: true, existencia: true },
    });
    const lote = previo
      ? await tx.hospLote.update({
          where: { id: previo.id },
          data: {
            existencia: { increment: cantidad },
            costoUnitario,
            ...(caducidad ? { caducidad } : {}),
            ...(invoiceId ? { invoiceId } : {}),
            ...(supplierId ? { supplierId } : {}),
          },
        })
      : await tx.hospLote.create({
          data: {
            companyId, insumoId, lote: nombreLote, caducidad,
            existencia: cantidad, costoUnitario, recibidoAt: fecha, invoiceId, supplierId,
          },
        });

    const referencia = [
      previo ? `Recepción adicional al lote ${nombreLote}` : `Recepción del lote ${nombreLote}`,
      nota || null,
    ]
      .filter(Boolean)
      .join(" · ");

    const derivado = invoiceId
      ? await tx.hospMovimientoInsumo.findUnique({
          where: { insumoId_invoiceId_tipo: { insumoId, invoiceId, tipo: "ENTRADA_COMPRA" } },
          select: { id: true, loteId: true, cantidad: true },
        })
      : null;

    let adoptadoDeCfdi = false;
    let movimiento;
    if (derivado && derivado.loteId == null) {
      adoptadoDeCfdi = true;
      movimiento = await tx.hospMovimientoInsumo.update({
        where: { id: derivado.id },
        data: {
          loteId: lote.id, cantidad, costoUnitario, fecha,
          referencia: `${referencia} · CFDI ${refCfdi} (${r2(Number(derivado.cantidad))} facturados)`,
          usuarioId: user.id, usuarioNombre,
        },
      });
    } else {
      movimiento = await tx.hospMovimientoInsumo.create({
        data: {
          companyId, insumoId, loteId: lote.id, tipo: "ENTRADA_COMPRA", cantidad, costoUnitario, fecha,
          // El invoiceId sólo puede vivir en UNA entrada por insumo: si ya lo
          // tiene otro lote de este CFDI, aquí va en texto.
          invoiceId: derivado ? null : invoiceId,
          referencia: derivado ? `${referencia} · CFDI ${refCfdi}` : referencia,
          usuarioId: user.id, usuarioNombre,
        },
      });
    }

    await tx.hospInsumo.update({ where: { id: insumoId }, data: { ultimoCosto: costoUnitario } });
    const existencia = await tx.hospMovimientoInsumo.aggregate({ where: { insumoId }, _sum: { cantidad: true } });
    return { lote, movimiento, adoptadoDeCfdi, existencia: r2(Number(existencia._sum.cantidad ?? 0)), sumadoALote: !!previo };
  });

  registrarBitacora({
    companyId,
    userId: user.id,
    actorEmail: user.email,
    accion: "hospital.lote.recibir",
    entidad: "HospLote",
    entidadId: resultado.lote.id,
    detalle: {
      insumoId, clave: insumo.clave, lote: nombreLote, cantidad, costoUnitario,
      caducidad: caducidad?.toISOString() ?? null, invoiceId, adoptadoDeCfdi: resultado.adoptadoDeCfdi,
    },
    req,
  });

  return NextResponse.json(
    {
      lote: {
        ...resultado.lote,
        existencia: r2(Number(resultado.lote.existencia)),
        costoUnitario: Number(resultado.lote.costoUnitario),
      },
      movimiento: {
        ...resultado.movimiento,
        cantidad: Number(resultado.movimiento.cantidad),
        costoUnitario: resultado.movimiento.costoUnitario == null ? null : Number(resultado.movimiento.costoUnitario),
      },
      adoptadoDeCfdi: resultado.adoptadoDeCfdi,
      sumadoALote: resultado.sumadoALote,
      existencia: resultado.existencia,
    },
    { status: 201 }
  );
});
