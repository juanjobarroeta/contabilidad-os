/**
 * GET /api/hospital/episodios/[id]/saeh — la hoja de egreso SAEH (GIIS-B002-05-09)
 *     del episodio: lo guardado en HospEgresoSaeh más el prellenado desde el
 *     expediente (peso/talla de signos, CIE de egreso, procedimiento con
 *     anestesia y cédula, servicios por especialidad, procedencia por tipo),
 *     los sociodemográficos del paciente, la validación del diccionario y las
 *     etiquetas de catálogo. Registra el acceso (LECTURA_EXPEDIENTE).
 * PUT /api/hospital/episodios/[id]/saeh { …campos de la hoja…, paciente?: { …sociodemográficos… } }[?reabrir=1]
 *     Guarda sólo lo que viene en el body (undefined = no tocar), recalcula la
 *     validación y deja estado COMPLETO sin errores o PENDIENTE. Una hoja ya
 *     EXPORTADA contesta 409 salvo reabrir=1 (corrección: conserva el folio).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { registrarAcceso } from "@/lib/hospital/accesos";
import { catalogoPrisma } from "@/lib/hospital/saeh/catalogo";
import { cargarFuenteSaeh } from "@/lib/hospital/saeh/contexto";
import { datosHojaParaGuardar, datosPacienteParaGuardar, hojaEntradaSchema, pacienteSaehSchema } from "@/lib/hospital/saeh/hoja";
import { prepararContexto } from "@/lib/hospital/saeh/prellenar";
import { armarRespuestaHoja } from "@/lib/hospital/saeh/respuesta";
import { estadoPorValidacion, validarSaeh } from "@/lib/hospital/saeh/validar";

type Ctx = { params: Promise<{ id: string }> };

const TIPOS_CON_EGRESO = new Set(["HOSPITALIZACION", "AMBULATORIO"]);

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const base = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, folio: true, pacienteId: true } });
  if (!base) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireMembership(base.companyId, undefined, req);
  await requireModule(base.companyId, "HOSPITAL", req);
  registrarAcceso({ companyId: base.companyId, accion: "LECTURA_EXPEDIENTE", episodioId: base.id, pacienteId: base.pacienteId, detalle: `Hoja SAEH ${base.folio}`, user, req });

  const fuente = await cargarFuenteSaeh(prisma, id);
  if (!fuente) throw new AuthzError(404, "Episodio no encontrado");
  const catalogo = catalogoPrisma(prisma);
  const contexto = await prepararContexto(fuente, catalogo);
  const validacion = await validarSaeh(contexto, catalogo);
  return NextResponse.json(await armarRespuestaHoja(contexto, validacion, catalogo));
});

const putSchema = hojaEntradaSchema.extend({
  paciente: pacienteSaehSchema.optional(),
  reabrir: z.boolean().optional(),
});

export const PUT = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { paciente: pacienteEntrada, reabrir: reabrirBody, ...hojaEntrada } = parsed.data;

  const base = await prisma.hospEpisodio.findUnique({
    where: { id },
    select: { id: true, companyId: true, folio: true, pacienteId: true, tipo: true, estado: true, egresoSaeh: { select: { id: true, estado: true, folioSaeh: true } } },
  });
  if (!base) throw new AuthzError(404, "Episodio no encontrado");

  const { user } = await requireWriter(base.companyId, req);
  await requireModule(base.companyId, "HOSPITAL", req);

  if (base.estado === "CANCELADO") return error(`El episodio ${base.folio} está cancelado`, 409);
  if (!TIPOS_CON_EGRESO.has(base.tipo)) return error(`El episodio ${base.folio} es de ${base.tipo}: sólo HOSPITALIZACION y AMBULATORIO generan egreso hospitalario (SAEH)`, 409);

  const reabrir = reabrirBody === true || new URL(req.url).searchParams.get("reabrir") === "1";
  if (base.egresoSaeh?.estado === "EXPORTADO" && !reabrir) {
    return error(`La hoja SAEH de ${base.folio} ya se exportó (folio ${base.egresoSaeh.folioSaeh ?? "s/n"}); envía reabrir=1 para corregirla y volver a exportar`, 409);
  }

  if (hojaEntrada.medicoResponsableId) {
    const m = await prisma.hospMedico.findUnique({ where: { id: hojaEntrada.medicoResponsableId }, select: { companyId: true } });
    if (!m || m.companyId !== base.companyId) return error("medicoResponsableId inválido");
  }

  const datos = datosHojaParaGuardar(hojaEntrada);
  const datosPaciente = pacienteEntrada ? datosPacienteParaGuardar(pacienteEntrada) : null;
  await prisma.$transaction(async (tx) => {
    await tx.hospEgresoSaeh.upsert({
      where: { episodioId: id },
      create: { companyId: base.companyId, episodioId: id, ...(datos as unknown as Omit<Prisma.HospEgresoSaehUncheckedCreateInput, "companyId" | "episodioId">) },
      update: datos,
    });
    if (datosPaciente && Object.keys(datosPaciente).length) {
      await tx.hospPaciente.update({ where: { id: base.pacienteId }, data: datosPaciente });
    }
  });

  const fuente = await cargarFuenteSaeh(prisma, id);
  if (!fuente) throw new AuthzError(404, "Episodio no encontrado");
  const catalogo = catalogoPrisma(prisma);
  const contexto = await prepararContexto(fuente, catalogo);
  const validacion = await validarSaeh(contexto, catalogo);
  const estado = estadoPorValidacion(validacion);
  await prisma.hospEgresoSaeh.update({
    where: { episodioId: id },
    data: { estado, validacion: validacion as unknown as Prisma.InputJsonValue },
  });

  bitacora(user, req, {
    companyId: base.companyId,
    accion: "hospital.saeh.guardar",
    entidad: "HospEgresoSaeh",
    entidadId: fuente.fila?.id ?? id,
    detalle: {
      folio: base.folio,
      estado,
      errores: validacion.errores.length,
      advertencias: validacion.advertencias.length,
      campos: Object.keys(hojaEntrada),
      paciente: datosPaciente ? Object.keys(datosPaciente) : [],
      reabierta: base.egresoSaeh?.estado === "EXPORTADO" && reabrir,
    },
  });

  return NextResponse.json(await armarRespuestaHoja(contexto, validacion, catalogo, { estado }));
});
