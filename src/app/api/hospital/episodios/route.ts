/**
 * GET  /api/hospital/episodios?companyId=…[&estado=ACTIVOS|ALTA|TODOS&q=]
 * POST /api/hospital/episodios — abre un episodio (ingreso) vía crearEpisodio.
 *
 * ACTIVOS = todo lo que no es ALTA ni CANCELADO (incluye PROGRAMADO: la cama
 * ya está reservada y la lista de «Pacientes de hoy» los enseña).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod, fechaSchema, usuarioDe } from "@/lib/hospital/http";
import { crearEpisodio } from "@/lib/hospital/episodio";
import { diaDeEstancia } from "@/lib/hospital/censo";
import { customerResumen, medicoResumen, pacienteResumen, recursoResumen, totalesCargos } from "@/lib/hospital/serializar";
import { ESTADOS_ACTIVOS } from "@/lib/hospital/util";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const estado = (searchParams.get("estado") ?? "ACTIVOS").toUpperCase();
  const q = searchParams.get("q")?.trim();

  const where: Prisma.HospEpisodioWhereInput = {
    companyId,
    ...(estado === "ACTIVOS" ? { estado: { in: ESTADOS_ACTIVOS } } : estado === "ALTA" ? { estado: "ALTA" } : {}),
    ...(q
      ? {
          OR: [
            { folio: { contains: q, mode: "insensitive" } },
            { paciente: { nombre: { contains: q, mode: "insensitive" } } },
            { paciente: { apellidoPaterno: { contains: q, mode: "insensitive" } } },
            { paciente: { apellidoMaterno: { contains: q, mode: "insensitive" } } },
            { diagnostico: { contains: q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const episodios = await prisma.hospEpisodio.findMany({
    where,
    include: {
      paciente: true,
      recurso: { select: { id: true, tipo: true, area: true, nombre: true, estado: true } },
      medico: { select: { id: true, nombre: true, especialidad: true } },
      pagador: { select: { id: true, nombre: true, tipo: true } },
      customer: { select: { id: true, razonSocial: true, rfc: true } },
      cargos: { select: { importe: true, ivaTasa: true, cancelado: true } },
      documentos: { where: { requerido: true, estado: "PENDIENTE" }, select: { id: true, tipo: true, nombre: true } },
    },
    orderBy: [{ fechaIngreso: "desc" }],
    take: estado === "TODOS" ? 500 : 300,
  });

  const hoy = new Date();
  return NextResponse.json(
    episodios.map((e) => {
      const { paciente, recurso, medico, pagador, customer, cargos, documentos, ...ep } = e;
      return {
        ...ep,
        paciente: pacienteResumen(paciente, hoy),
        recurso: recursoResumen(recurso),
        medico: medicoResumen(medico),
        pagador: pagador ? { id: pagador.id, nombre: pagador.nombre, tipo: pagador.tipo } : null,
        customer: customerResumen(customer),
        diaEstancia: diaDeEstancia(e.fechaIngreso, e.fechaAlta ?? hoy),
        cuentaTotal: totalesCargos(cargos).total,
        pendientes: documentos.length,
        documentosPendientes: documentos,
      };
    })
  );
});

const createSchema = z.object({
  companyId: z.string().min(1),
  pacienteId: z.string().min(1),
  tipo: z.enum(["HOSPITALIZACION", "AMBULATORIO", "URGENCIAS", "CONSULTA"]),
  recursoId: z.string().nullable().optional(),
  medicoId: z.string().nullable().optional(),
  pagadorId: z.string().nullable().optional(),
  customerId: z.string().nullable().optional(),
  diagnosticoCie10: z.string().max(10).nullable().optional(),
  diagnostico: z.string().max(300).nullable().optional(),
  procedimiento: z.string().max(300).nullable().optional(),
  motivo: z.string().max(1000).nullable().optional(),
  autorizacionPagador: z.string().max(80).nullable().optional(),
  notasAdmin: z.string().max(4000).nullable().optional(),
  cotizacionId: z.string().nullable().optional(),
  fechaIngreso: fechaSchema.nullable().optional(),
});

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const { user } = await requireWriter(d.companyId, req);
  await requireModule(d.companyId, "HOSPITAL", req);

  const episodio = await crearEpisodio(prisma, {
    ...d,
    fechaIngreso: aFecha(d.fechaIngreso),
    usuario: usuarioDe(user),
  });

  bitacora(user, req, {
    companyId: d.companyId,
    accion: "hospital.episodio.crear",
    entidad: "HospEpisodio",
    entidadId: episodio.id,
    detalle: {
      folio: episodio.folio,
      tipo: episodio.tipo,
      estado: episodio.estado,
      cama: episodio.recurso?.nombre ?? null,
      cotizacionId: episodio.cotizacionId,
      cargosCopiados: episodio.cargos.length,
    },
  });

  return NextResponse.json(
    {
      ...episodio,
      paciente: pacienteResumen(episodio.paciente),
      medico: medicoResumen(episodio.medico),
      customer: customerResumen(episodio.customer),
      diaEstancia: diaDeEstancia(episodio.fechaIngreso, new Date()),
    },
    { status: 201 }
  );
});
