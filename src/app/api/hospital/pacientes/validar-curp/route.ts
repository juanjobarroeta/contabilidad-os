/**
 * GET /api/hospital/pacientes/validar-curp?companyId=&curp=[&excluirPacienteId=]
 *
 * Resultado local de RENAPO (valida, motivo, fechaNacimiento, sexo, entidad)
 * más `duplicado` si otro paciente de la empresa ya tiene esa CURP. La
 * captura lo llama al salir del campo; el alta vuelve a validar de todos
 * modos. Equivale a POST /api/hospital/validar-curp.
 */

import { NextResponse } from "next/server";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { validarCurpParaEmpresa } from "@/lib/hospital/paciente-schema";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const curp = searchParams.get("curp") ?? "";
  return NextResponse.json(await validarCurpParaEmpresa(companyId, curp, searchParams.get("excluirPacienteId")));
});
