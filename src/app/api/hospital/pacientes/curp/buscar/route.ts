/**
 * POST /api/hospital/pacientes/curp/buscar
 *      { companyId, nombres, primerApellido, segundoApellido?, fechaNacimiento (AAAA-MM-DD), sexo: H|M|X, entidadClave }
 *
 * Busca la CURP en RENAPO por datos (proveedor del hub) y SIEMPRE calcula la
 * CURP probable localmente (16 posiciones + homoclave supuesta + dígito):
 * sin proveedor o con RENAPO caído contesta `disponible: false` y sólo la
 * probable, para que la captura la proponga marcada como `curpProbable`.
 * `entidadClave` admite la clave RENAPO («PL»), la DGIS («21») o el nombre.
 * Registra HospAcceso CONSULTA_RENAPO.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error, errorZod } from "@/lib/hospital/http";
import { registrarAcceso } from "@/lib/hospital/accesos";
import { calcularCurp, entidadCurpDe, sexoCurpDe } from "@/lib/hospital/identidad";
import { pacienteConCurp } from "@/lib/hospital/paciente-schema";
import { estadoProveedor, obtenerProveedor } from "@/lib/hospital/renapo/proveedor";
import { RenapoError, datosRenapo } from "@/lib/hospital/renapo/tipos";

const schema = z.object({
  companyId: z.string().min(1),
  nombres: z.string().trim().min(1).max(120),
  primerApellido: z.string().trim().min(1).max(120),
  segundoApellido: z.string().trim().max(120).nullable().optional(),
  fechaNacimiento: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "fechaNacimiento AAAA-MM-DD"),
  sexo: z.string().trim().min(1).max(12),
  entidadClave: z.string().trim().min(1).max(40),
});

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, ...q } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const sexo = sexoCurpDe(q.sexo);
  if (!sexo) return error("sexo debe ser H, M o X");
  const entidadClave = entidadCurpDe(q.entidadClave);
  if (!entidadClave) return error(`Entidad no reconocida: «${q.entidadClave}» (usa la clave RENAPO, p. ej. PL, o la DGIS, p. ej. 21)`);

  const probable = calcularCurp({ nombres: q.nombres, primerApellido: q.primerApellido, segundoApellido: q.segundoApellido, fechaNacimiento: q.fechaNacimiento, sexo, entidadClave });
  const curpProbable = probable.ok ? probable.curp : null;
  const duplicado = curpProbable ? await pacienteConCurp(companyId, curpProbable) : null;
  const base = { curpProbable, curpProbableMotivo: probable.ok ? null : probable.error, duplicadoProbable: duplicado };

  const estado = estadoProveedor();
  const proveedor = obtenerProveedor();
  if (!proveedor) return NextResponse.json({ disponible: false, motivo: estado.motivo, registros: [], multiple: false, proveedor: estado.proveedor, ...base });

  try {
    const registros = await proveedor.buscarPorDatos({ nombres: q.nombres, primerApellido: q.primerApellido, segundoApellido: q.segundoApellido ?? null, fechaNacimiento: q.fechaNacimiento, sexo, entidadClave });
    registrarAcceso({ companyId, accion: "CONSULTA_RENAPO", detalle: `Búsqueda por datos · ${proveedor.nombre} · ${registros.length} registro(s)`, user, req });
    return NextResponse.json({
      disponible: true,
      registros: registros.map(datosRenapo),
      multiple: registros.length > 1,
      proveedor: proveedor.nombre,
      referencia: registros[0]?.referencia ?? null,
      ...base,
      coincideProbable: !!curpProbable && registros.some((r) => r.curp === curpProbable),
    });
  } catch (e) {
    if (!(e instanceof RenapoError)) throw e;
    registrarAcceso({ companyId, accion: "CONSULTA_RENAPO", detalle: `Búsqueda por datos · ${proveedor.nombre} · ${e.codigo}`, user, req });
    if (e.codigo === "NOT_FOUND") return NextResponse.json({ disponible: true, registros: [], multiple: false, proveedor: proveedor.nombre, motivo: e.message, ...base });
    if (e.codigo === "MULTIPLE_MATCHES") return NextResponse.json({ disponible: true, registros: [], multiple: true, proveedor: proveedor.nombre, motivo: e.message, ...base });
    if (e.codigo === "INVALID_FORMAT") return error(e.message, 400);
    return NextResponse.json({ disponible: false, registros: [], multiple: false, proveedor: proveedor.nombre, motivo: e.message, codigo: e.codigo, ...base });
  }
});
