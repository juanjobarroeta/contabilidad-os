import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";
import { headersDescargaXlsx, toXlsx, type XlsxRow } from "@/lib/export/xlsx";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/empleados/export?companyId=…[&activos=1]
//
// El padrón completo en Excel: TODAS las columnas del empleado, no las siete
// de la tabla. Es lo que el contador manda al despacho, al IMSS o al banco
// (CLABE), y lo que se cruza contra la hoja del ISN. Números como números,
// fechas como fechas (lib/export/xlsx). Una hoja; sin datos de terceros.
// ─────────────────────────────────────────────────────────────────────────────

const PERIODICIDAD: Record<string, string> = { "01": "Diario", "02": "Semanal", "03": "Catorcenal", "04": "Quincenal", "05": "Mensual", "06": "Bimestral", "99": "Otra" };
const CONTRATO: Record<string, string> = { "01": "Indefinido", "02": "Obra determinada", "03": "Tiempo determinado", "04": "Temporada", "05": "Prueba", "06": "Capacitación inicial", "07": "Sin contrato", "08": "Becario", "09": "Comisión", "10": "Otro" };

export async function GET(req: Request) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  const member = await getEffectiveCompanyMembership(user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });
  const soloActivos = searchParams.get("activos") === "1";

  const [empleados, company] = await Promise.all([
    prisma.employee.findMany({
      where: { companyId, ...(soloActivos ? { isActive: true } : {}) },
      orderBy: [{ isActive: "desc" }, { apellidoPaterno: "asc" }, { nombre: "asc" }],
      include: {
        payrollItems: {
          where: { payrollRun: { status: { in: ["STAMPED", "PAID"] } } },
          orderBy: { payrollRun: { fechaPago: "desc" } },
          take: 1,
          select: { payrollRun: { select: { fechaPago: true, periodo: true } } },
        },
      },
    }),
    prisma.company.findUnique({ where: { id: companyId }, select: { rfc: true, razonSocial: true, registroPatronal: true } }),
  ]);

  const hoy = new Date();
  const n = (v: unknown) => (v == null ? null : Number(v));
  const antiguedad = (d: Date) => Math.max(0, Math.floor((hoy.getTime() - d.getTime()) / (365.25 * 86400000) * 10) / 10);

  const headers = [
    "No. empleado", "Nombre", "Apellido paterno", "Apellido materno", "RFC", "CURP", "NSS", "Email", "CP",
    "Fecha de ingreso", "Antigüedad (años)", "Fecha de baja", "Estado",
    "Tipo de contrato", "Jornada", "Régimen", "Periodicidad",
    "Salario diario", "SDI (SBC)", "Riesgo de puesto", "Puesto", "Departamento", "Entidad", "Registro patronal",
    "CLABE", "Banco", "Crédito Infonavit", "Tipo desc. Infonavit", "Descuento Infonavit", "Crédito Fonacot", "Descuento Fonacot",
    "Pensión alimenticia (tipo)", "Pensión alimenticia (valor)",
    "Último recibo (pago)", "Último recibo (periodo)",
  ];
  const rows: XlsxRow[] = empleados.map((e) => {
    const ur = e.payrollItems[0]?.payrollRun ?? null;
    return [
      e.numEmpleado ?? "", e.nombre, e.apellidoPaterno, e.apellidoMaterno ?? "", e.rfc, e.curp, e.nss, e.email ?? "", e.codigoPostal ?? "",
      e.fechaIngreso, antiguedad(e.fechaIngreso), e.fechaBaja, e.isActive ? "Activo" : "Baja",
      CONTRATO[e.tipoContrato] ?? e.tipoContrato, e.tipoJornada ?? "", e.tipoRegimen ?? "", PERIODICIDAD[e.periodicidadPago] ?? e.periodicidadPago,
      n(e.salarioDiario), n(e.salarioDiarioIntegrado), e.riesgoPuesto ?? "", e.puesto ?? "", e.departamento ?? "", e.claveEntFed ?? "", e.registroPatronal ?? company?.registroPatronal ?? "",
      e.clabe ?? "", e.banco ?? "", e.creditoInfonavit ?? "", e.tipoDescuentoInfonavit ?? "", n(e.descuentoInfonavit), e.creditoFonacot ?? "", n(e.descuentoFonacot),
      e.pensionAlimenticiaTipo ?? "", n(e.pensionAlimenticiaValor),
      ur?.fechaPago ?? null, ur?.periodo ?? "",
    ];
  });

  const libro = toXlsx([{
    nombre: "Empleados",
    headers,
    rows,
    anchos: [10, 18, 18, 18, 14, 20, 12, 26, 7, 12, 10, 12, 8, 18, 10, 10, 12, 12, 12, 10, 22, 18, 8, 14, 20, 14, 14, 12, 12, 14, 12, 14, 12, 12, 24],
  }]);
  const filename = `empleados_${company?.rfc ?? companyId}_${hoy.toISOString().slice(0, 10)}.xlsx`;
  return new NextResponse(new Uint8Array(libro), { status: 200, headers: headersDescargaXlsx(filename) });
}
