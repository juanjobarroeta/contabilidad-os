/**
 * GET  /api/construccion/trabajadores?companyId=…[&todos=1]
 * POST /api/construccion/trabajadores
 *
 * Registro único de los trabajadores de obra de la empresa (la mayoría fuera
 * de la nómina fiscal): cómo se les paga (por DÍA o por HORA) y cuánto. Entran
 * a las cuadrillas de cada obra como miembros, y su asistencia genera su
 * jornal en la raya semanal.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { trabajadorSchema } from "@/lib/construccion/trabajador-schema";

const select = {
  id: true,
  nombre: true,
  telefono: true,
  especialidad: true,
  tipoPago: true,
  tarifa: true,
  horasJornada: true,
  employeeId: true,
  isActive: true,
} as const;

export const GET = withAuthz(async (req: Request) => {
  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "CONSTRUCCION");

  const todos = url.searchParams.get("todos") === "1";
  const rows = await prisma.trabajador.findMany({
    where: { companyId, ...(todos ? {} : { isActive: true }) },
    select,
    orderBy: { nombre: "asc" },
  });
  return NextResponse.json(rows);
});

const createSchema = trabajadorSchema.extend({ companyId: z.string().min(1) });

export const POST = withAuthz(async (req: Request) => {
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, employeeId, ...data } = parsed.data;
  await requireWriter(companyId, req);
  await requireModule(companyId, "CONSTRUCCION");

  if (employeeId) {
    const e = await prisma.employee.findUnique({ where: { id: employeeId }, select: { companyId: true } });
    if (!e || e.companyId !== companyId) {
      return NextResponse.json({ error: "Empleado inválido" }, { status: 400 });
    }
  }

  const created = await prisma.trabajador.create({
    data: {
      companyId,
      nombre: data.nombre,
      telefono: data.telefono ?? null,
      especialidad: data.especialidad ?? null,
      tipoPago: data.tipoPago,
      tarifa: data.tarifa,
      ...(data.horasJornada !== undefined ? { horasJornada: data.horasJornada } : {}),
      employeeId: employeeId ?? null,
    },
    select,
  });
  return NextResponse.json(created, { status: 201 });
});
