/**
 * GET  /api/salameria/listas?companyId=...
 * POST /api/salameria/listas
 *
 * Listas de precios. La marcada `publica` es la del menudeo: es la que ve la
 * tienda sin sesión y la BASE de la que se derivan las de mayoreo por
 * descuento. Sólo puede haber una publica por empresa — dos harían que el
 * precio del escaparate dependiera de cuál devolvió Postgres primero.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";

export const GET = withAuthz(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "SALAMERIA", req);

  const listas = await prisma.salListaPrecio.findMany({
    where: { companyId },
    orderBy: [{ publica: "desc" }, { nombre: "asc" }],
    include: { _count: { select: { precios: true, cuentas: true } } },
  });

  return NextResponse.json(listas);
});

const createSchema = z.object({
  companyId: z.string().min(1),
  nombre: z.string().min(1).max(80).transform((v) => v.trim()),
  tipo: z.enum(["MENUDEO", "MAYOREO", "CLIENTE"]).default("MAYOREO"),
  publica: z.boolean().default(false),
  descuento: z.number().min(0).max(0.95).default(0),
  activa: z.boolean().default(true),
});

export const POST = withAuthz(async (req: Request) => {
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, ...data } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "SALAMERIA", req);

  const existe = await prisma.salListaPrecio.findUnique({
    where: { companyId_nombre: { companyId, nombre: data.nombre } },
    select: { id: true },
  });
  if (existe) {
    return NextResponse.json(
      { error: `Ya existe una lista llamada «${data.nombre}»` },
      { status: 409 }
    );
  }

  const lista = await prisma.$transaction(async (tx) => {
    // Marcar ésta como pública apaga la anterior: la exclusividad se mantiene
    // aquí porque Postgres no puede expresar «un solo true por companyId» con
    // un @@unique (habría un choque por cada fila en false).
    if (data.publica) {
      await tx.salListaPrecio.updateMany({
        where: { companyId, publica: true },
        data: { publica: false },
      });
    }
    return tx.salListaPrecio.create({ data: { companyId, ...data } });
  });

  return NextResponse.json(lista, { status: 201 });
});
