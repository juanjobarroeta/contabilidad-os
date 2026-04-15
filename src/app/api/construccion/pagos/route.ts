/**
 * GET  /api/construccion/pagos?proyectoId=...
 * POST /api/construccion/pagos
 *
 * Clean payments model replacing the inline anticipo button. Supports
 * ANTICIPO, ESTIMACION, and RETENCION_LIBERADA payment types.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { postAnticipoRecibido } from "@/lib/accounting/postings";

const createSchema = z.object({
  proyectoId: z.string().min(1),
  tipo: z.enum(["ANTICIPO", "ESTIMACION", "RETENCION_LIBERADA"]),
  monto: z.number().positive(),
  fecha: z.string().datetime().optional(),
  referencia: z.string().optional(),
  bankAccountId: z.string().optional(),
  estimacionId: z.string().optional(),
});

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const proyectoId = searchParams.get("proyectoId");
  if (!proyectoId) return NextResponse.json({ error: "proyectoId requerido" }, { status: 400 });

  const proy = await prisma.proyecto.findUnique({ where: { id: proyectoId }, select: { companyId: true } });
  if (!proy) return NextResponse.json({ error: "Proyecto no encontrado" }, { status: 404 });

  await requireMembership(proy.companyId, undefined, req);
  await requireModule(proy.companyId, "CONSTRUCCION");

  const pagos = await prisma.pago.findMany({
    where: { proyectoId },
    orderBy: { fecha: "desc" },
  });

  return NextResponse.json(pagos);
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const proy = await prisma.proyecto.findUnique({
    where: { id: parsed.data.proyectoId },
    select: { id: true, companyId: true, codigo: true, anticipoMonto: true },
  });
  if (!proy) return NextResponse.json({ error: "Proyecto no encontrado" }, { status: 404 });

  await requireWriter(proy.companyId, req);
  await requireModule(proy.companyId, "CONSTRUCCION");

  const fecha = parsed.data.fecha ? new Date(parsed.data.fecha) : new Date();

  const result = await prisma.$transaction(async (tx) => {
    // Create bank transaction if bankAccountId is provided
    let bankTxId: string | undefined;
    if (parsed.data.bankAccountId) {
      const bankTx = await tx.bankTransaction.create({
        data: {
          companyId: proy.companyId,
          bankAccountId: parsed.data.bankAccountId,
          fecha,
          descripcion: `Pago ${parsed.data.tipo} — ${proy.codigo}`,
          referencia: parsed.data.referencia ?? proy.codigo,
          monto: parsed.data.tipo === "ANTICIPO"
            ? Math.abs(parsed.data.monto)   // credit (deposit)
            : -Math.abs(parsed.data.monto), // debit (payment out)
          tipo: parsed.data.tipo === "ANTICIPO" ? "CREDITO" : "DEBITO",
          status: "MATCHED",
          source: "UPLOAD",
        },
      });
      bankTxId = bankTx.id;
    }

    // Post accounting entries for anticipo
    if (parsed.data.tipo === "ANTICIPO") {
      await postAnticipoRecibido(tx, {
        companyId: proy.companyId,
        proyectoId: proy.id,
        proyectoCodigo: proy.codigo,
        monto: parsed.data.monto,
        fecha,
      });

      // Update proyecto anticipo tracking
      await tx.proyecto.update({
        where: { id: proy.id },
        data: {
          anticipoMonto: parsed.data.monto,
          anticipoFecha: fecha,
          anticipoBankTxId: bankTxId,
        },
      });
    }

    const pago = await tx.pago.create({
      data: {
        proyectoId: proy.id,
        companyId: proy.companyId,
        tipo: parsed.data.tipo,
        monto: parsed.data.monto,
        fecha,
        referencia: parsed.data.referencia,
        bankAccountId: parsed.data.bankAccountId,
        bankTransactionId: bankTxId,
        estimacionId: parsed.data.estimacionId,
      },
    });

    return pago;
  });

  return NextResponse.json(result, { status: 201 });
});
