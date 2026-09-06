/**
 * POST /api/hospital/pacientes/[id]/verificar-curp [{ curp? }]
 *
 * Verifica en RENAPO la CURP del paciente (o la que llega en el body cuando
 * la ficha no tiene) y guarda el resultado: curpEstatus, curpVerificadaAt/
 * Fuente/Ref, renapoNombres/PrimerApellido/SegundoApellido, renapoCoincide
 * (captura vs. RENAPO sin acentos) y curpOrigen = RENAPO, curpProbable = false.
 * Si la CURP está dada de baja (BD, BSU, BAP, BDM, BDP, BJD) contesta 200 con
 * `verificacion.activa: false` y una advertencia explícita; el hospital decide.
 *
 *   503 sin proveedor configurado · 409 si RENAPO no la tiene registrada ·
 *   502 con RENAPO caído / límite / credenciales · 400 CURP inválida
 *
 * Registra HospAcceso CONSULTA_RENAPO (proveedor + estatus).
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { registrarAcceso } from "@/lib/hospital/accesos";
import { validarCurp } from "@/lib/hospital/curp";
import { compararConRenapo, sexoCurpDe } from "@/lib/hospital/identidad";
import { identidadDeFicha, mensajeCurpDuplicada, pacienteConCurp } from "@/lib/hospital/paciente-schema";
import { estadoProveedor, obtenerProveedor } from "@/lib/hospital/renapo/proveedor";
import { RenapoError, datosRenapo, descripcionEstatus } from "@/lib/hospital/renapo/tipos";
import { customerResumen, pacienteResumen, pagadorResumen } from "@/lib/hospital/serializar";
import { claveDia } from "@/lib/hospital/tz";

const schema = z.object({ curp: z.string().trim().max(40).optional() }).nullable().optional();

export const POST = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.text().then((t) => (t.trim() ? JSON.parse(t) : null)).catch(() => undefined);
  if (body === undefined) return error("Body inválido (JSON)");
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);

  const paciente = await prisma.hospPaciente.findUnique({ where: { id } });
  if (!paciente) throw new AuthzError(404, "Paciente no encontrado");

  const { user } = await requireWriter(paciente.companyId, req);
  await requireModule(paciente.companyId, "HOSPITAL", req);

  const candidata = paciente.curp ?? parsed.data?.curp ?? null;
  if (!candidata) return error("El paciente no tiene CURP: mándala en el body ({ curp }) o captúrala en la ficha", 400);
  const local = validarCurp(candidata);
  if (!local.valida) return error(local.motivo ?? "CURP inválida");
  if (!paciente.curp) {
    const dup = await pacienteConCurp(paciente.companyId, local.curp, id);
    if (dup) return error(mensajeCurpDuplicada(dup, local.curp), 409);
  }

  const proveedor = obtenerProveedor();
  if (!proveedor) return error(estadoProveedor().motivo ?? "Consulta a RENAPO no configurada", 503);

  let registro;
  try {
    registro = await proveedor.consultarPorCurp(local.curp);
  } catch (e) {
    if (!(e instanceof RenapoError)) throw e;
    registrarAcceso({ companyId: paciente.companyId, accion: "CONSULTA_RENAPO", pacienteId: paciente.id, detalle: `Verificación · ${proveedor.nombre} · ${e.codigo}`, user, req });
    if (e.codigo === "NOT_FOUND") return error(`RENAPO no tiene registrada la CURP ${local.curp}: revísala con el documento del paciente`, 409);
    if (e.codigo === "INVALID_FORMAT") return error(e.message, 400);
    return error(e.message, 502);
  }
  registrarAcceso({ companyId: paciente.companyId, accion: "CONSULTA_RENAPO", pacienteId: paciente.id, detalle: `Verificación · ${proveedor.nombre} · ${registro.estatusCurp || "sin estatus"}`, user, req });

  const comparacion = compararConRenapo(
    {
      nombres: paciente.nombre,
      primerApellido: paciente.apellidoPaterno,
      segundoApellido: paciente.apellidoMaterno,
      fechaNacimiento: paciente.fechaNacimiento ? claveDia(paciente.fechaNacimiento) : null,
      sexo: paciente.sexo,
    },
    { nombres: registro.nombres, primerApellido: registro.primerApellido, segundoApellido: registro.segundoApellido, fechaNacimiento: registro.fechaNacimiento, sexo: registro.sexo }
  );
  const ahora = new Date();
  const actualizado = await prisma.hospPaciente.update({
    where: { id },
    data: {
      ...(paciente.curp ? {} : { curp: registro.curp, curpValidada: true, sinCurp: false, sinCurpMotivo: null, sexo: paciente.sexo ?? (sexoCurpDe(registro.sexo) === "H" ? "MASCULINO" : sexoCurpDe(registro.sexo) === "M" ? "FEMENINO" : null) }),
      curpOrigen: "RENAPO",
      curpProbable: false,
      curpEstatus: registro.estatusCurp || null,
      curpVerificadaAt: ahora,
      curpVerificadaFuente: registro.proveedor,
      curpVerificadaRef: registro.referencia,
      renapoNombres: registro.nombres || null,
      renapoPrimerApellido: registro.primerApellido || null,
      renapoSegundoApellido: registro.segundoApellido,
      renapoCoincide: comparacion.coincide,
    },
    include: { pagador: true, customer: { select: { id: true, razonSocial: true, rfc: true } } },
  });

  bitacora(user, req, {
    companyId: paciente.companyId,
    accion: "hospital.paciente.verificar-curp",
    entidad: "HospPaciente",
    entidadId: id,
    detalle: { curp: registro.curp, proveedor: registro.proveedor, estatus: registro.estatusCurp, activa: registro.activa, coincide: comparacion.coincide, diferencias: comparacion.diferencias.map((d) => d.campo) },
  });

  const advertencias: string[] = [];
  if (!registro.activa) advertencias.push(`La CURP ${registro.curp} está dada de baja en RENAPO (${registro.estatusCurp}: ${descripcionEstatus(registro.estatusCurp)}); confirma la identidad del paciente con otro documento antes de continuar`);
  if (!comparacion.coincide) advertencias.push(`Los datos capturados no coinciden con RENAPO en: ${comparacion.diferencias.map((d) => `${d.campo} («${d.captura ?? "—"}» vs «${d.renapo ?? "—"}»)`).join(", ")}`);

  return NextResponse.json({
    ...actualizado,
    ...pacienteResumen(actualizado, ahora),
    pagador: pagadorResumen(actualizado.pagador),
    customer: customerResumen(actualizado.customer),
    identidad: await identidadDeFicha(actualizado, ahora),
    verificacion: {
      encontrada: true,
      estatus: registro.estatusCurp,
      estatusDescripcion: descripcionEstatus(registro.estatusCurp),
      activa: registro.activa,
      coincide: comparacion.coincide,
      diferencias: comparacion.diferencias,
      proveedor: registro.proveedor,
      referencia: registro.referencia,
      consultadoEn: registro.consultadoEn,
      datos: datosRenapo(registro),
      advertencias,
      advertencia: advertencias[0] ?? null,
    },
  });
});
