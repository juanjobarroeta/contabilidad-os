/**
 * GET   /api/hospital/pacientes/[id] — la ficha: datos, episodios con su
 *       cuenta (total, facturado, saldo), cotizaciones y citas.
 * PATCH /api/hospital/pacientes/[id] — edición de la ficha.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod } from "@/lib/hospital/http";
import { customerResumen, medicoResumen, pacienteResumen, pagadorResumen, recursoResumen, totalesCargos } from "@/lib/hospital/serializar";
import { r2 } from "@/lib/hospital/util";
import { pacienteSchema, validarVinculosPaciente } from "@/lib/hospital/paciente-schema";

type Ctx = { params: Promise<{ id: string }> };

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const paciente = await prisma.hospPaciente.findUnique({
    where: { id },
    include: {
      pagador: true,
      customer: { select: { id: true, razonSocial: true, rfc: true } },
      episodios: {
        orderBy: { fechaIngreso: "desc" },
        include: {
          medico: { select: { id: true, nombre: true, especialidad: true } },
          recurso: { select: { id: true, tipo: true, area: true, nombre: true, estado: true } },
          pagador: { select: { id: true, nombre: true, tipo: true } },
          cargos: {
            select: { importe: true, ivaTasa: true, cancelado: true, invoice: { select: { id: true, total: true, status: true } } },
          },
        },
      },
      cotizaciones: {
        orderBy: { createdAt: "desc" },
        select: { id: true, folio: true, procedimiento: true, estado: true, total: true, vigenciaHasta: true, createdAt: true, pagador: { select: { id: true, nombre: true } } },
      },
      citas: {
        orderBy: { inicio: "desc" },
        take: 50,
        select: {
          id: true, tipo: true, titulo: true, inicio: true, fin: true, estado: true, episodioId: true,
          recurso: { select: { id: true, nombre: true, tipo: true } },
          medico: { select: { id: true, nombre: true } },
        },
      },
    },
  });
  if (!paciente) throw new AuthzError(404, "Paciente no encontrado");

  await requireMembership(paciente.companyId, undefined, req);
  await requireModule(paciente.companyId, "HOSPITAL", req);

  const { episodios, cotizaciones, citas, pagador, customer, ...datos } = paciente;
  return NextResponse.json({
    ...datos,
    ...pacienteResumen(paciente),
    pagador: pagadorResumen(pagador),
    customer: customerResumen(customer),
    episodios: episodios.map((e) => {
      const { cargos, medico, recurso, pagador: pag, ...ep } = e;
      const totales = totalesCargos(cargos);
      // Facturado = total de los CFDIs (no cancelados) que amparan cargos del
      // episodio, cada CFDI una vez aunque cubra varios renglones.
      const facturas = new Map<string, number>();
      for (const c of cargos) if (c.invoice && c.invoice.status !== "CANCELLED") facturas.set(c.invoice.id, Number(c.invoice.total));
      const facturado = r2([...facturas.values()].reduce((s, t) => s + t, 0));
      return {
        ...ep,
        medico: medicoResumen(medico),
        recurso: recursoResumen(recurso),
        pagador: pag ? { id: pag.id, nombre: pag.nombre, tipo: pag.tipo } : null,
        total: totales.total,
        subtotal: totales.subtotal,
        facturado,
        saldo: r2(Math.max(0, totales.total - facturado)),
      };
    }),
    cotizaciones: cotizaciones.map((c) => ({ ...c, total: Number(c.total) })),
    citas,
  });
});

export const PATCH = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = pacienteSchema.partial().safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);

  const paciente = await prisma.hospPaciente.findUnique({ where: { id }, select: { id: true, companyId: true } });
  if (!paciente) throw new AuthzError(404, "Paciente no encontrado");

  const { user } = await requireWriter(paciente.companyId, req);
  await requireModule(paciente.companyId, "HOSPITAL", req);

  const invalido = await validarVinculosPaciente(paciente.companyId, parsed.data);
  if (invalido) return error(invalido);

  const { fechaNacimiento, curp, ...data } = parsed.data;
  const actualizado = await prisma.hospPaciente.update({
    where: { id },
    data: {
      ...data,
      ...(curp !== undefined ? { curp: curp?.trim().toUpperCase() || null } : {}),
      ...(fechaNacimiento !== undefined ? { fechaNacimiento: aFecha(fechaNacimiento) } : {}),
    },
    include: { pagador: true, customer: { select: { id: true, razonSocial: true, rfc: true } } },
  });

  bitacora(user, req, {
    companyId: paciente.companyId,
    accion: "hospital.paciente.editar",
    entidad: "HospPaciente",
    entidadId: id,
    detalle: { campos: Object.keys(parsed.data) },
  });

  return NextResponse.json({
    ...actualizado,
    ...pacienteResumen(actualizado),
    pagador: pagadorResumen(actualizado.pagador),
    customer: customerResumen(actualizado.customer),
  });
});
