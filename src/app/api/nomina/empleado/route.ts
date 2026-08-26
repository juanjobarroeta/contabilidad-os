import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, withAuthz } from "@/lib/authz";
import { SALARIO_MINIMO_GENERAL } from "@/lib/nomina/constants";
import { Prisma } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nomina/empleado?companyId=…[&incluirBajas=1]
//
// El ROSTER: la lista de empleados de la empresa, para surfacear la nómina en
// el satélite (AutomotrizPro no la tenía). El detalle por empleado ya vive en
// /api/nomina/empleado/[id]; faltaba la colección. Por default sólo activos —
// entrar a nómina es ver a quién le pagas hoy; las bajas se piden con bandera.
// ─────────────────────────────────────────────────────────────────────────────
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);

  const incluirBajas = searchParams.get("incluirBajas") === "1";
  const empleados = await prisma.employee.findMany({
    where: { companyId, ...(incluirBajas ? {} : { isActive: true }) },
    orderBy: [{ isActive: "desc" }, { apellidoPaterno: "asc" }],
    select: {
      id: true, numEmpleado: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true,
      rfc: true, curp: true, puesto: true, departamento: true, tipoRegimen: true,
      periodicidadPago: true, salarioDiario: true, salarioDiarioIntegrado: true,
      fechaIngreso: true, fechaBaja: true, isActive: true,
    },
  });

  // Última fecha de pago por empleado. El flag isActive del padrón está
  // desincronizado de la realidad (en MARGOM: 281 personas con recibo en los
  // últimos 45 días y 245 de ellas marcadas inactivas), así que el cliente
  // necesita el dato duro —cuándo cobró por última vez— para derivar quién
  // está EN NÓMINA, en lugar de creerle a la marca.
  const ultimos = await prisma.$queryRaw<Array<{ employeeId: string; ultimo: Date }>>(
    Prisma.sql`
      SELECT i."employeeId", max(r."fechaPago") AS ultimo
      FROM "PayrollItem" i
      JOIN "PayrollRun" r ON r.id = i."payrollRunId"
      WHERE r."companyId" = ${companyId}
        -- Hay corridas TIMBRADAS con fecha de pago futura (el pre-timbrado de
        -- la quincena en curso y finiquitos fechados al 31-dic). Son CFDIs
        -- reales, pero un pago futuro no es evidencia de que alguien cobra
        -- HOY: sin este recorte, el cliente mostraría «último pago 31/12» y
        -- derivaría «en nómina» de un hecho que aún no ocurre.
        AND r."fechaPago" <= now()
      GROUP BY 1
    `
  );
  const ultimoBy = new Map(ultimos.map((u) => [u.employeeId, u.ultimo]));

  return NextResponse.json({
    total: empleados.length,
    activos: empleados.filter((e) => e.isActive).length,
    // El mínimo vigente viaja con el roster para que el cliente compare el
    // salario REGISTRADO contra el piso legal sin cablearse la cifra: es el
    // dato que separa «en el mínimo» de «por debajo» (el IMSS rechaza el alta
    // sub-mínima) y cambia cada año por decreto.
    salarioMinimoGeneral: SALARIO_MINIMO_GENERAL,
    empleados: empleados.map((e) => ({
      ...e,
      nombreCompleto: `${e.nombre} ${e.apellidoPaterno} ${e.apellidoMaterno ?? ""}`.trim(),
      ultimoPago: ultimoBy.get(e.id) ?? null,
    })),
  });
});
