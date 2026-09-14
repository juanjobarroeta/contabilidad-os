import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, AuthzError, getEffectiveCompanyMembership } from "@/lib/authz";
import { headersDescargaXlsx, toXlsx, type XlsxRow } from "@/lib/export/xlsx";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nomina/run/[id]/xlsx — la corrida en Excel, un recibo por fila.
//
// Sale de PayrollItem (los importes con los que se calculó y timbró), no del
// XML: es la corrida tal como la app la corrió. Números como números.
// ─────────────────────────────────────────────────────────────────────────────

const TIPO: Record<string, string> = { ORDINARIA: "Ordinaria", EXTRAORDINARIA: "Extraordinaria", FINIQUITO: "Finiquito", AGUINALDO: "Aguinaldo", VACACIONES: "Vacaciones", PTU: "PTU" };

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { id } = await params;
  const run = await prisma.payrollRun.findUnique({
    where: { id },
    include: {
      company: { select: { rfc: true, razonSocial: true } },
      items: {
        include: { employee: { select: { numEmpleado: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true, rfc: true, curp: true, nss: true, puesto: true, departamento: true, salarioDiario: true, salarioDiarioIntegrado: true, clabe: true, banco: true } } },
        orderBy: { employee: { apellidoPaterno: "asc" } },
      },
    },
  });
  if (!run) return NextResponse.json({ error: "Corrida no encontrada" }, { status: 404 });
  const member = await getEffectiveCompanyMembership(user.id, run.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const n = (v: unknown) => (v == null ? null : Number(v));
  const headers = [
    "No. empleado", "Empleado", "RFC", "CURP", "NSS", "Puesto", "Departamento", "Salario diario", "SDI",
    "Sueldo", "Horas extra", "Bonos fijos", "Bonos variables", "Vales", "Otras percepciones", "Aguinaldo", "Prima vacacional", "Vacaciones", "PTU", "Total percepciones",
    "ISR retenido", "IMSS obrero", "Infonavit", "Otras deducciones", "Total deducciones", "Neto a pagar",
    "IMSS patronal", "CLABE", "Banco", "UUID",
  ];
  const rows: XlsxRow[] = run.items.map((i) => {
    const e = i.employee;
    return [
      e.numEmpleado ?? "", `${e.nombre} ${e.apellidoPaterno} ${e.apellidoMaterno ?? ""}`.trim(), e.rfc, e.curp, e.nss, e.puesto ?? "", e.departamento ?? "", n(e.salarioDiario), n(e.salarioDiarioIntegrado),
      n(i.sueldoBase), n(i.horasExtra), n(i.bonosPagoFijo), n(i.bonosPagoVar), n(i.vales), n(i.otrasPercepciones), n(i.aguinaldo), n(i.primaVacacional), n(i.vacaciones), n(i.ptu), n(i.totalPercepciones),
      n(i.isrRetenido), n(i.imssObrero), n(i.infonavit), n(i.otrasDeducc), n(i.totalDeducciones), n(i.netoAPagar),
      n(i.imssPatronal), e.clabe ?? "", e.banco ?? "", i.cfdiUuid ?? "",
    ];
  });
  // Fila de totales al final: lo que el contador compara contra la dispersión.
  const sum = (idx: number) => rows.reduce((s, r) => s + (Number(r[idx]) || 0), 0);
  rows.push(["", `TOTAL · ${rows.length} recibos`, "", "", "", "", "", null, null,
    ...[9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26].map((c) => Math.round(sum(c) * 100) / 100),
    "", "", ""]);

  const libro = toXlsx([{
    nombre: `${TIPO[run.tipo] ?? run.tipo} ${run.periodo}`.slice(0, 31),
    headers, rows,
    anchos: [9, 30, 14, 20, 12, 18, 16, 11, 11, 11, 10, 10, 11, 9, 12, 11, 12, 11, 9, 13, 11, 11, 10, 12, 13, 13, 12, 20, 12, 38],
  }]);
  const filename = `nomina_${run.company.rfc}_${(TIPO[run.tipo] ?? run.tipo).toLowerCase()}_${run.periodo.replace(/\//g, "_")}.xlsx`;
  return new NextResponse(new Uint8Array(libro), { status: 200, headers: headersDescargaXlsx(filename) });
}
