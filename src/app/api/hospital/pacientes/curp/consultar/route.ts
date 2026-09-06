/**
 * POST /api/hospital/pacientes/curp/consultar { companyId, curp }
 *
 * Consulta la CURP en RENAPO a través del proveedor configurado en el hub
 * (RENAPO_PROVEEDOR=tlaloc|nubarium). Antes valida la CURP localmente (400
 * si no pasa formato/dígito). Sin proveedor o con RENAPO caído contesta 200
 * con `disponible: false` y el motivo: la captura sigue con la validación
 * local. Registra HospAcceso CONSULTA_RENAPO (proveedor + estatus, nunca el
 * registro completo). No guarda nada: eso lo hace /pacientes/[id]/verificar-curp.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error, errorZod } from "@/lib/hospital/http";
import { registrarAcceso } from "@/lib/hospital/accesos";
import { validarCurp } from "@/lib/hospital/curp";
import { pacienteConCurp } from "@/lib/hospital/paciente-schema";
import { estadoProveedor, obtenerProveedor } from "@/lib/hospital/renapo/proveedor";
import { RenapoError, datosRenapo, descripcionEstatus } from "@/lib/hospital/renapo/tipos";

const schema = z.object({
  companyId: z.string().min(1),
  curp: z.string().trim().min(1).max(40),
});

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const local = validarCurp(parsed.data.curp);
  if (!local.valida) return error(local.motivo ?? "CURP inválida");
  const curp = local.curp;
  const duplicado = await pacienteConCurp(companyId, curp);

  const estado = estadoProveedor();
  const proveedor = obtenerProveedor();
  if (!proveedor) {
    return NextResponse.json({ disponible: false, motivo: estado.motivo, encontrada: null, estatus: null, activa: null, datos: null, proveedor: estado.proveedor, referencia: null, duplicado });
  }

  try {
    const r = await proveedor.consultarPorCurp(curp);
    registrarAcceso({ companyId, accion: "CONSULTA_RENAPO", detalle: `Consulta por CURP · ${proveedor.nombre} · ${r.estatusCurp || "sin estatus"}`, user, req });
    return NextResponse.json({
      disponible: true,
      encontrada: true,
      estatus: r.estatusCurp,
      estatusDescripcion: descripcionEstatus(r.estatusCurp),
      activa: r.activa,
      advertencia: r.activa ? null : `La CURP ${r.curp} está dada de baja en RENAPO (${r.estatusCurp}: ${descripcionEstatus(r.estatusCurp)}); confirma la identidad con otro documento antes de usarla`,
      datos: datosRenapo(r),
      proveedor: r.proveedor,
      referencia: r.referencia,
      consultadoEn: r.consultadoEn,
      duplicado,
    });
  } catch (e) {
    if (!(e instanceof RenapoError)) throw e;
    registrarAcceso({ companyId, accion: "CONSULTA_RENAPO", detalle: `Consulta por CURP · ${proveedor.nombre} · ${e.codigo}`, user, req });
    if (e.codigo === "NOT_FOUND") {
      return NextResponse.json({ disponible: true, encontrada: false, estatus: null, activa: null, datos: null, proveedor: proveedor.nombre, referencia: null, motivo: e.message, duplicado });
    }
    if (e.codigo === "INVALID_FORMAT") return error(e.message, 400);
    // RENAPO caído, límite del proveedor o credenciales: la captura sigue sin RENAPO.
    return NextResponse.json({ disponible: false, encontrada: null, estatus: null, activa: null, datos: null, proveedor: proveedor.nombre, referencia: null, motivo: e.message, codigo: e.codigo, duplicado });
  }
});
