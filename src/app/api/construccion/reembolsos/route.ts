/**
 * GET  /api/construccion/reembolsos?companyId=... [&proyectoId=...] [&estado=...]
 * POST /api/construccion/reembolsos
 *
 * ReembolsoSemanal = Rosy's weekly "concentrado de gastos" package.
 * Header row that groups multiple Gasto line items + (future) nómina.
 * List endpoint returns summary rows with running totals; POST creates
 * a new empty SUBMITTED package that Katia fills line by line.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  AuthzError,
  requireMembership,
  requireModule,
  requireWriter,
  withAuthz,
} from "@/lib/authz";

const createSchema = z.object({
  proyectoId: z.string().min(1),
  // Opcional desde el rediseño de caja chica: sin cuenta, el período se ancla
  // a la cuenta CAJA de la empresa (se crea "Caja chica" de efectivo si no
  // existe). La cuenta bancaria real del reembolso se decide al CERRAR el
  // período (picker de movimientos), no al abrirlo — preguntar por BBVA al
  // crear un período de efectivo sólo confundía.
  bankAccountId: z.string().min(1).optional(),
  semanaInicio: z.string(),
  semanaFin: z.string(),
  anticipoAplicado: z.number().nonnegative().optional(),
  notas: z.string().max(1000).nullable().optional(),
});

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const proyectoId = url.searchParams.get("proyectoId");
  const estado = url.searchParams.get("estado");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const rows = await prisma.reembolsoSemanal.findMany({
    where: {
      companyId,
      ...(proyectoId ? { proyectoId } : {}),
      ...(estado
        ? {
            estado: estado as
              | "SUBMITTED"
              | "REVISADO"
              | "REEMBOLSADO"
              | "RECHAZADO",
          }
        : {}),
    },
    include: {
      proyecto: { select: { id: true, codigo: true, nombre: true } },
      bankAccount: { select: { id: true, banco: true, nombre: true, tipo: true } },
      _count: { select: { gastos: true } },
    },
    orderBy: { semanaInicio: "desc" },
    take: 200,
  });
  return NextResponse.json(rows);
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const proyecto = await prisma.proyecto.findUnique({
    where: { id: parsed.data.proyectoId },
    select: { companyId: true },
  });
  if (!proyecto) throw new AuthzError(404, "Proyecto no encontrado");
  await requireWriter(proyecto.companyId, req);
  await requireModule(proyecto.companyId, "CONSTRUCCION");

  let bankAccountId = parsed.data.bankAccountId ?? null;
  if (bankAccountId) {
    const account = await prisma.bankAccount.findUnique({
      where: { id: bankAccountId },
      select: { id: true, companyId: true },
    });
    if (!account || account.companyId !== proyecto.companyId) {
      return NextResponse.json({ error: "BankAccount inválido" }, { status: 400 });
    }
  } else {
    // Caja chica: anclar a la cuenta CAJA de la empresa; crearla si no existe.
    // No es una cuenta bancaria real — es el fondo de efectivo del responsable.
    const caja =
      (await prisma.bankAccount.findFirst({
        where: { companyId: proyecto.companyId, tipo: "CAJA" },
        select: { id: true },
      })) ??
      (await prisma.bankAccount.create({
        data: {
          companyId: proyecto.companyId,
          banco: "EFECTIVO",
          nombre: "Caja chica",
          numeroCuenta: "EFECTIVO",
          tipo: "CAJA",
        },
        select: { id: true },
      }));
    bankAccountId = caja.id;
  }

  try {
    const created = await prisma.reembolsoSemanal.create({
      data: {
        companyId: proyecto.companyId,
        proyectoId: parsed.data.proyectoId,
        bankAccountId,
        semanaInicio: new Date(parsed.data.semanaInicio),
        semanaFin: new Date(parsed.data.semanaFin),
        anticipoAplicado: parsed.data.anticipoAplicado ?? 0,
        notas: parsed.data.notas ?? null,
      },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && (e as { code: string }).code === "P2002") {
      return NextResponse.json(
        { error: "Ya existe un reembolso para este proyecto en esa semana" },
        { status: 409 }
      );
    }
    throw e;
  }
});
