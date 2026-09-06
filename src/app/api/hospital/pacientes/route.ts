/**
 * GET  /api/hospital/pacientes?companyId=…[&q=&activo=1|0]
 * POST /api/hospital/pacientes
 *
 * El padrón de pacientes. Cada fila trae lo que la lista enseña sin abrir la
 * ficha: nombre completo, edad, convenio, receptor fiscal, cuántos episodios
 * y el último, y el saldo (Σ de la cuenta de sus episodios abiertos).
 *
 * Alta (P1, NOM-024 / LFPDPPP): CURP obligatoria y validada —o `sinCurp` con
 * motivo—, única por empresa; fecha de nacimiento, sexo y entidad se cruzan
 * con la CURP (y se toman de ella si faltan); `expedienteNumero` se asigna
 * (EXP-AAAA-NNNN) y no se edita; el aviso de privacidad deja versión y fecha.
 *
 * P2: origen de la CURP (CAPTURA/DOCUMENTO/CALCULADA; RENAPO sólo por
 * /verificar-curp), RFC con estructura válida y fuente, identificación
 * oficial con vigencia y sociodemográficos SAEH con claves que existen en los
 * catálogos DGIS (país, entidad, municipio, localidad, lengua, afiliación).
 * La respuesta trae el bloque `identidad` con sus pendientes.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { conFolioUnico, siguienteFolio } from "@/lib/hospital/folio";
import { customerResumen, pacienteResumen, pagadorResumen, totalesCargos } from "@/lib/hospital/serializar";
import { ESTADOS_ACTIVOS } from "@/lib/hospital/util";
import {
  CAMPOS_IDENTIDAD_P1,
  CAMPOS_IDENTIDAD_P2,
  CAMPOS_SAEH,
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
} from "@/lib/hospital/paciente-schema";

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
              { rfc: { contains: q, mode: "insensitive" } },
              { expedienteNumero: { contains: q, mode: "insensitive" } },
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
        curpVerificada: p.curpOrigen === "RENAPO",
      };
    })
  );
});

const createSchema = pacienteSchema.extend({ companyId: z.string().min(1) });

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, ...entrada } = parsed.data;
  const [p1, resto1] = partir(entrada, CAMPOS_IDENTIDAD_P1);
  const [p2, resto2] = partir(resto1, CAMPOS_IDENTIDAD_P2);
  const [saeh, data] = partir(resto2, CAMPOS_SAEH);

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const invalido = await validarVinculosPaciente(companyId, data);
  if (invalido) return error(invalido);

  const identidad = resolverIdentidadCurp({
    curp: p1.curp,
    sinCurp: p1.sinCurp,
    sinCurpMotivo: p1.sinCurpMotivo,
    sexo: p1.sexo,
    fechaNacimiento: fechaNacimientoDe(p1.fechaNacimiento),
    entidadNacimiento: p1.entidadNacimiento,
    exigirCurp: true,
  });
  if (!identidad.ok) return error(identidad.error, identidad.status);
  if (identidad.datos.curp) {
    const dup = await pacienteConCurp(companyId, identidad.datos.curp);
    if (dup) return error(mensajeCurpDuplicada(dup, identidad.datos.curp), 409);
  }
  const identidadP2 = resolverDatosIdentidadP2(p2, null);
  if (!identidadP2.ok) return error(identidadP2.error, identidadP2.status);
  const origen = origenCurpDe(p2, !!identidad.datos.curp);

  // Entidad y país de nacimiento: si la captura no los trae, la CURP los implica.
  const implicito = nacimientoDesdeCurp(identidad.datos.curp);
  const saehEntrada = {
    ...saeh,
    ...(saeh.entidadNacimientoClave == null && implicito.entidadNacimientoClave ? { entidadNacimientoClave: implicito.entidadNacimientoClave } : {}),
    ...(saeh.paisNacimientoClave == null && implicito.paisNacimientoClave ? { paisNacimientoClave: implicito.paisNacimientoClave } : {}),
  };
  const claves = await validarClavesSaeh(saehEntrada, null, identidad.datos.curp);
  if (!claves.ok) return error(claves.error, claves.status);

  const hoy = new Date();
  const aviso = await avisoPrivacidadDe(companyId, { avisoPrivacidadAceptado: p1.avisoPrivacidadAceptado, avisoPrivacidadAceptadoAt: p1.avisoPrivacidadAceptadoAt, avisoPrivacidadVersion: p1.avisoPrivacidadVersion }, hoy);

  const paciente = await conFolioUnico(() =>
    prisma.$transaction(async (tx) => {
      const expedienteNumero = await siguienteFolio(tx, companyId, "expediente", hoy);
      return tx.hospPaciente.create({
        data: { companyId, ...data, ...identidad.datos, ...aviso, ...identidadP2.datos, ...origen, ...saehEntrada, ...claves.datos, expedienteNumero },
        include: {
          pagador: { select: { id: true, nombre: true, tipo: true, tabulador: true, deducible: true, coaseguroPct: true, plazoDias: true, topeAutorizacion: true } },
          customer: { select: { id: true, razonSocial: true, rfc: true } },
        },
      });
    })
  );

  bitacora(user, req, {
    companyId,
    accion: "hospital.paciente.crear",
    entidad: "HospPaciente",
    entidadId: paciente.id,
    detalle: { nombre: `${paciente.nombre} ${paciente.apellidoPaterno}`, curp: paciente.curp, curpOrigen: paciente.curpOrigen, sinCurp: paciente.sinCurp, rfc: paciente.rfc, expedienteNumero: paciente.expedienteNumero },
  });

  return NextResponse.json(
    { ...paciente, ...pacienteResumen(paciente), pagador: pagadorResumen(paciente.pagador), customer: customerResumen(paciente.customer), identidad: await identidadDeFicha(paciente, hoy) },
    { status: 201 }
  );
});
