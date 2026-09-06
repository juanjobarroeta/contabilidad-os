/**
 * GET   /api/hospital/pacientes/[id] — la ficha: datos, episodios con su
 *       cuenta (total, facturado, saldo), cotizaciones, citas y el bloque
 *       `identidad` (CURP: origen/estatus RENAPO; RFC y su cruce con la CURP;
 *       identificación y vigencia; aviso de privacidad; pendientes). Registra
 *       el acceso (LECTURA_FICHA) sin bloquear la respuesta.
 * PATCH /api/hospital/pacientes/[id] — edición de la ficha. Si toca la
 *       identidad (curp, sinCurp, sinCurpMotivo) aplica la misma regla que el
 *       alta; `expedienteNumero` y `curpValidada` nunca vienen del body. Una
 *       CURP verificada en RENAPO sólo se sustituye con `motivoCambio` (400 si
 *       falta) y al cambiarla se borra lo que RENAPO dijo de la anterior.
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
  CAMPOS_IDENTIDAD_P1,
  CAMPOS_IDENTIDAD_P2,
  CAMPOS_SAEH,
  REINICIO_VERIFICACION,
  avisoPrivacidadDe,
  fechaNacimientoDe,
  identidadDeFicha,
  mensajeCurpDuplicada,
  nacimientoDesdeCurp,
  origenCurpDe,
  pacienteConCurp,
  pacienteSchema,
  partir,
  resolverDatosIdentidadP2,
  resolverIdentidadCurp,
  validarClavesSaeh,
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
      // Documentos del paciente (aviso, identificación, contratos): sólo el resumen.
      documentos: {
        where: { episodioId: null },
        orderBy: { createdAt: "asc" },
        select: { id: true, tipo: true, nombre: true, estado: true, requerido: true, firmadoAt: true, plantillaVersion: true, createdAt: true },
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

  const hoy = new Date();
  const { episodios, cotizaciones, citas, pagador, customer, documentos, ...datos } = paciente;
  return NextResponse.json({
    ...datos,
    ...pacienteResumen(paciente, hoy),
    pagador: pagadorResumen(pagador),
    customer: customerResumen(customer),
    identidad: await identidadDeFicha(paciente, hoy),
    documentos,
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

const CAMPOS_CURP = ["curp", "sinCurp", "sinCurpMotivo"] as const;

export const PATCH = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = pacienteSchema.partial().safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);

  const paciente = await prisma.hospPaciente.findUnique({ where: { id } });
  if (!paciente) throw new AuthzError(404, "Paciente no encontrado");

  const { user } = await requireWriter(paciente.companyId, req);
  await requireModule(paciente.companyId, "HOSPITAL", req);

  const [p1, resto1] = partir(parsed.data, CAMPOS_IDENTIDAD_P1);
  const [p2, resto2] = partir(resto1, CAMPOS_IDENTIDAD_P2);
  const [saeh, data] = partir(resto2, CAMPOS_SAEH);

  const invalido = await validarVinculosPaciente(paciente.companyId, data);
  if (invalido) return error(invalido);

  const tocaIdentidad = CAMPOS_CURP.some((c) => c in parsed.data);
  const tocaFicha = p1.fechaNacimiento !== undefined || p1.sexo !== undefined;

  // Identidad resultante = lo guardado + lo que llega; la regla es la del
  // alta cuando se toca la CURP, y sólo la coherencia con la CURP existente
  // cuando se toca fecha o sexo.
  let identidad: Partial<IdentidadPaciente> = {};
  if (tocaIdentidad || tocaFicha) {
    const r = resolverIdentidadCurp({
      curp: p1.curp !== undefined ? p1.curp : paciente.curp,
      sinCurp: p1.sinCurp !== undefined ? p1.sinCurp : paciente.sinCurp,
      sinCurpMotivo: p1.sinCurpMotivo !== undefined ? p1.sinCurpMotivo : paciente.sinCurpMotivo,
      sexo: p1.sexo !== undefined ? p1.sexo : paciente.sexo,
      fechaNacimiento: p1.fechaNacimiento !== undefined ? fechaNacimientoDe(p1.fechaNacimiento) : paciente.fechaNacimiento,
      entidadNacimiento: p1.entidadNacimiento !== undefined ? p1.entidadNacimiento : paciente.entidadNacimiento,
      exigirCurp: tocaIdentidad,
    });
    if (!r.ok) return error(r.error, r.status);
    if (r.datos.curp && r.datos.curp !== paciente.curp) {
      const dup = await pacienteConCurp(paciente.companyId, r.datos.curp, id);
      if (dup) return error(mensajeCurpDuplicada(dup, r.datos.curp), 409);
    }
    identidad = r.datos;
  } else if (p1.entidadNacimiento !== undefined) {
    identidad = { entidadNacimiento: p1.entidadNacimiento?.trim() || null };
  }

  // P2: una CURP verificada en RENAPO no se sustituye sin motivo; al cambiar
  // la CURP se reinicia lo que RENAPO dijo de la anterior.
  const curpResultante = identidad.curp !== undefined ? identidad.curp : paciente.curp;
  const curpCambia = tocaIdentidad && curpResultante !== paciente.curp;
  let origen: Record<string, unknown> = {};
  if (curpCambia) {
    if (paciente.curpOrigen === "RENAPO" && !p2.motivoCambio) {
      return error(`La CURP ${paciente.curp} está verificada en RENAPO: para sustituirla indica motivoCambio (p. ej. «RENAPO corrigió la homoclave», «captura equivocada»)`, 400);
    }
    origen = { ...REINICIO_VERIFICACION, ...origenCurpDe(p2, !!curpResultante) };
  } else if (p2.curpOrigen !== undefined || p2.curpProbable !== undefined) {
    if (paciente.curpOrigen === "RENAPO") return error("La CURP verificada en RENAPO conserva su origen; si es otra CURP, cámbiala con motivoCambio", 400);
    if (paciente.curp) origen = origenCurpDe({ curpOrigen: p2.curpOrigen ?? paciente.curpOrigen, curpProbable: p2.curpProbable ?? paciente.curpProbable }, true);
  }

  const identidadP2 = resolverDatosIdentidadP2(p2, paciente);
  if (!identidadP2.ok) return error(identidadP2.error, identidadP2.status);

  const implicito = curpCambia ? nacimientoDesdeCurp(curpResultante) : { entidadNacimientoClave: null, paisNacimientoClave: null };
  const saehEntrada = {
    ...saeh,
    ...(saeh.entidadNacimientoClave === undefined && implicito.entidadNacimientoClave ? { entidadNacimientoClave: implicito.entidadNacimientoClave } : {}),
    ...(saeh.paisNacimientoClave === undefined && paciente.paisNacimientoClave == null && implicito.paisNacimientoClave ? { paisNacimientoClave: implicito.paisNacimientoClave } : {}),
  };
  const claves = await validarClavesSaeh(saehEntrada, paciente, curpResultante);
  if (!claves.ok) return error(claves.error, claves.status);

  const aviso = await avisoPrivacidadDe(paciente.companyId, { avisoPrivacidadAceptado: p1.avisoPrivacidadAceptado, avisoPrivacidadAceptadoAt: p1.avisoPrivacidadAceptadoAt, avisoPrivacidadVersion: p1.avisoPrivacidadVersion });

  const actualizado = await prisma.hospPaciente.update({
    where: { id },
    data: { ...data, ...identidad, ...aviso, ...identidadP2.datos, ...origen, ...saehEntrada, ...claves.datos },
    include: { pagador: true, customer: { select: { id: true, razonSocial: true, rfc: true } } },
  });

  bitacora(user, req, {
    companyId: paciente.companyId,
    accion: "hospital.paciente.editar",
    entidad: "HospPaciente",
    entidadId: id,
    detalle: {
      campos: Object.keys(parsed.data),
      curp: actualizado.curp !== paciente.curp ? actualizado.curp : undefined,
      curpAnterior: actualizado.curp !== paciente.curp ? paciente.curp : undefined,
      motivoCambio: curpCambia ? (p2.motivoCambio ?? null) : undefined,
    },
  });

  return NextResponse.json({
    ...actualizado,
    ...pacienteResumen(actualizado),
    pagador: pagadorResumen(actualizado.pagador),
    customer: customerResumen(actualizado.customer),
    identidad: await identidadDeFicha(actualizado),
  });
});
