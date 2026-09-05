/**
 * GET   /api/hospital/pacientes/[id] — la ficha: datos, episodios con su
 *       cuenta (total, facturado, saldo), cotizaciones y citas. Registra el
 *       acceso (LECTURA_FICHA) sin bloquear la respuesta.
 * PATCH /api/hospital/pacientes/[id] — edición de la ficha. Si toca la
 *       identidad (curp, sinCurp, sinCurpMotivo) aplica la misma regla que el
 *       alta; `expedienteNumero` y `curpValidada` nunca vienen del body.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { registrarAcceso } from "@/lib/hospital/accesos";
import { customerResumen, medicoResumen, pacienteResumen, pagadorResumen, recursoResumen, totalesCargos } from "@/lib/hospital/serializar";
import { nombreCompleto, r2 } from "@/lib/hospital/util";
import {
  avisoPrivacidadDe,
  fechaNacimientoDe,
  mensajeCurpDuplicada,
  pacienteConCurp,
  pacienteSchema,
  resolverIdentidadCurp,
  validarVinculosPaciente,
  type IdentidadPaciente,
} from "@/lib/hospital/paciente-schema";

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

  const { user } = await requireMembership(paciente.companyId, undefined, req);
  await requireModule(paciente.companyId, "HOSPITAL", req);

  registrarAcceso({
    companyId: paciente.companyId,
    accion: "LECTURA_FICHA",
    pacienteId: paciente.id,
    detalle: `Ficha ${paciente.expedienteNumero ?? nombreCompleto(paciente)}`,
    user,
    req,
  });

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

const CAMPOS_IDENTIDAD = ["curp", "sinCurp", "sinCurpMotivo"] as const;

export const PATCH = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = pacienteSchema.partial().safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);

  const paciente = await prisma.hospPaciente.findUnique({ where: { id } });
  if (!paciente) throw new AuthzError(404, "Paciente no encontrado");

  const { user } = await requireWriter(paciente.companyId, req);
  await requireModule(paciente.companyId, "HOSPITAL", req);

  const invalido = await validarVinculosPaciente(paciente.companyId, parsed.data);
  if (invalido) return error(invalido);

  const { fechaNacimiento, curp, sinCurp, sinCurpMotivo, sexo, entidadNacimiento, avisoPrivacidadAceptado, avisoPrivacidadAceptadoAt, avisoPrivacidadVersion, ...data } = parsed.data;
  const tocaIdentidad = CAMPOS_IDENTIDAD.some((c) => c in parsed.data);
  const tocaFicha = fechaNacimiento !== undefined || sexo !== undefined;

  // Identidad resultante = lo guardado + lo que llega; la regla es la del
  // alta cuando se toca la CURP, y sólo la coherencia con la CURP existente
  // cuando se toca fecha o sexo.
  let identidad: Partial<IdentidadPaciente> = {};
  if (tocaIdentidad || tocaFicha) {
    const r = resolverIdentidadCurp({
      curp: curp !== undefined ? curp : paciente.curp,
      sinCurp: sinCurp !== undefined ? sinCurp : paciente.sinCurp,
      sinCurpMotivo: sinCurpMotivo !== undefined ? sinCurpMotivo : paciente.sinCurpMotivo,
      sexo: sexo !== undefined ? sexo : paciente.sexo,
      fechaNacimiento: fechaNacimiento !== undefined ? fechaNacimientoDe(fechaNacimiento) : paciente.fechaNacimiento,
      entidadNacimiento: entidadNacimiento !== undefined ? entidadNacimiento : paciente.entidadNacimiento,
      exigirCurp: tocaIdentidad,
    });
    if (!r.ok) return error(r.error, r.status);
    if (r.datos.curp && r.datos.curp !== paciente.curp) {
      const dup = await pacienteConCurp(paciente.companyId, r.datos.curp, id);
      if (dup) return error(mensajeCurpDuplicada(dup, r.datos.curp), 409);
    }
    identidad = r.datos;
  } else if (entidadNacimiento !== undefined) {
    identidad = { entidadNacimiento: entidadNacimiento?.trim() || null };
  }

  const aviso = await avisoPrivacidadDe(paciente.companyId, { avisoPrivacidadAceptado, avisoPrivacidadAceptadoAt, avisoPrivacidadVersion });

  const actualizado = await prisma.hospPaciente.update({
    where: { id },
    data: { ...data, ...identidad, ...aviso },
    include: { pagador: true, customer: { select: { id: true, razonSocial: true, rfc: true } } },
  });

  bitacora(user, req, {
    companyId: paciente.companyId,
    accion: "hospital.paciente.editar",
    entidad: "HospPaciente",
    entidadId: id,
    detalle: { campos: Object.keys(parsed.data), curp: actualizado.curp !== paciente.curp ? actualizado.curp : undefined },
  });

  return NextResponse.json({
    ...actualizado,
    ...pacienteResumen(actualizado),
    pagador: pagadorResumen(actualizado.pagador),
    customer: customerResumen(actualizado.customer),
  });
});
