/**
 * GET  /api/hospital/pacientes?companyId=…[&q=&activo=1|0]
 * POST /api/hospital/pacientes
 *
 * El padrón de pacientes. Cada fila trae lo que la lista enseña sin abrir la
 * ficha: nombre completo, edad, convenio, receptor fiscal, cuántos episodios
 * y el último, y el saldo (Σ de la cuenta de sus episodios abiertos).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod } from "@/lib/hospital/http";
import { customerResumen, pacienteResumen, pagadorResumen, totalesCargos } from "@/lib/hospital/serializar";
import { ESTADOS_ACTIVOS } from "@/lib/hospital/util";
import { pacienteSchema, validarVinculosPaciente } from "@/lib/hospital/paciente-schema";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const q = searchParams.get("q")?.trim();
  const activo = searchParams.get("activo");

  const pacientes = await prisma.hospPaciente.findMany({
    where: {
      companyId,
      ...(activo === "1" || activo === "true" ? { activo: true } : activo === "0" || activo === "false" ? { activo: false } : {}),
      ...(q
        ? {
            OR: [
              { nombre: { contains: q, mode: "insensitive" } },
              { apellidoPaterno: { contains: q, mode: "insensitive" } },
              { apellidoMaterno: { contains: q, mode: "insensitive" } },
              { curp: { contains: q, mode: "insensitive" } },
              { telefono: { contains: q } },
            ],
          }
        : {}),
    },
    include: {
      pagador: { select: { id: true, nombre: true, tipo: true } },
      customer: { select: { id: true, razonSocial: true, rfc: true } },
      _count: { select: { episodios: true } },
      episodios: {
        orderBy: { fechaIngreso: "desc" },
        take: 1,
        select: { id: true, folio: true, tipo: true, estado: true, fechaIngreso: true, fechaAlta: true },
      },
    },
    orderBy: [{ apellidoPaterno: "asc" }, { nombre: "asc" }],
    take: 500,
  });

  // Saldo = cuenta viva de los episodios abiertos, sumada por paciente en una
  // sola consulta (no una por fila).
  const cargos = await prisma.hospCargo.findMany({
    where: { companyId, cancelado: false, episodio: { estado: { in: ESTADOS_ACTIVOS }, pacienteId: { in: pacientes.map((p) => p.id) } } },
    select: { importe: true, ivaTasa: true, cancelado: true, episodio: { select: { pacienteId: true } } },
  });
  const porPaciente = new Map<string, typeof cargos>();
  for (const c of cargos) {
    const lista = porPaciente.get(c.episodio.pacienteId) ?? [];
    lista.push(c);
    porPaciente.set(c.episodio.pacienteId, lista);
  }

  const hoy = new Date();
  return NextResponse.json(
    pacientes.map((p) => {
      const { pagador, customer, _count, episodios, ...resto } = p;
      return {
        ...resto,
        ...pacienteResumen(p, hoy),
        pagador: pagador ? { id: pagador.id, nombre: pagador.nombre, tipo: pagador.tipo } : null,
        customer: customerResumen(customer),
        episodios: _count.episodios,
        ultimoEpisodio: episodios[0] ?? null,
        saldo: totalesCargos(porPaciente.get(p.id) ?? []).total,
      };
    })
  );
});

const createSchema = pacienteSchema.extend({ companyId: z.string().min(1) });

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, fechaNacimiento, curp, ...data } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const invalido = await validarVinculosPaciente(companyId, data);
  if (invalido) return error(invalido);

  const paciente = await prisma.hospPaciente.create({
    data: {
      companyId,
      ...data,
      curp: curp?.trim().toUpperCase() || null,
      fechaNacimiento: aFecha(fechaNacimiento),
    },
    include: {
      pagador: { select: { id: true, nombre: true, tipo: true, tabulador: true, deducible: true, coaseguroPct: true, plazoDias: true, topeAutorizacion: true } },
      customer: { select: { id: true, razonSocial: true, rfc: true } },
    },
  });

  bitacora(user, req, {
    companyId,
    accion: "hospital.paciente.crear",
    entidad: "HospPaciente",
    entidadId: paciente.id,
    detalle: { nombre: `${paciente.nombre} ${paciente.apellidoPaterno}`, curp: paciente.curp },
  });

  return NextResponse.json(
    { ...paciente, ...pacienteResumen(paciente), pagador: pagadorResumen(paciente.pagador), customer: customerResumen(paciente.customer) },
    { status: 201 }
  );
});
