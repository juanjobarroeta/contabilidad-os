/**
 * POST /api/hospital/nomina/empleados { companyId, nombre, apellidoPaterno, rfc, curp, nss, fechaIngreso, salarioDiario, … }
 *
 * Alta de un empleado desde el satélite con la misma regla que /api/empleados
 * (lib/nomina/empleados.ts): SDI por factor de integración si no se captura,
 * numEmpleado por default. El roster se lee de GET /api/hospital/empleados.
 *
 * Puerta del hospital: página nomina y FINANZAS_ESCRIBIR.
 */

import { NextResponse } from "next/server";
import { requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { assertPuedeEscribir } from "@/lib/subscription";
import { crearEmpleado, empleadoSchema } from "@/lib/nomina/empleados";

export const POST = withHospital(async (req: Request) => {
  const parsed = empleadoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? "Datos inválidos");
  const { companyId } = parsed.data;
  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);
  await assertPuedeEscribir(user.id);
  const empleado = await crearEmpleado(parsed.data);
  bitacora(user, req, {
    companyId,
    accion: "nomina.empleado.alta",
    entidad: "Employee",
    entidadId: empleado.id,
    detalle: { rfc: empleado.rfc, puesto: empleado.puesto },
  });
  return NextResponse.json(empleado, { status: 201 });
});
