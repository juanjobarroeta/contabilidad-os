/**
 * POST /api/hospital/validar-curp { companyId, curp, excluirPacienteId? }
 *
 * Valida la CURP como lo hará el alta del paciente (formato, fecha, sexo,
 * entidad y dígito verificador de RENAPO) y avisa si otro paciente de la
 * empresa ya la tiene. Misma respuesta que GET /pacientes/validar-curp.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { errorZod } from "@/lib/hospital/http";
import { validarCurpParaEmpresa } from "@/lib/hospital/paciente-schema";

const schema = z.object({
  companyId: z.string().min(1),
  curp: z.string().max(40),
  excluirPacienteId: z.string().nullable().optional(),
});

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, curp, excluirPacienteId } = parsed.data;

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  return NextResponse.json(await validarCurpParaEmpresa(companyId, curp, excluirPacienteId));
});
