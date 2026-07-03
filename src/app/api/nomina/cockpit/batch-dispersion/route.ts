import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { gateEscritura } from "@/lib/subscription";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nomina/cockpit/batch-dispersion — archivo de dispersión SPEI en LOTE
// para varias empresas del despacho desde el cockpit. Acción SEGURA y de sólo
// lectura: genera UN solo CSV con TODOS los empleados de TODAS las empresas
// seleccionadas para el mismo periodo (quincena). NO timbra, NO ejecuta pagos,
// NO cambia estado — sólo exporta.
//
// Parámetros (query):
//  - companyIds: lista separada por comas de empresas a incluir.
//  - periodoInicio + periodoFin: la quincena (formato YYYY-MM-DD), con la que
//    se arma la misma clave de periodo que createPayrollRun/batch-calcular.
//
// Por cada empresa se resuelve su corrida MÁS RECIENTE no-DRAFT para ese
// periodo y, si su status es CALCULATED o STAMPED (mismas reglas que el
// endpoint de dispersión por corrida), se incluyen todos sus PayrollItems.
//
// Reglas de omisión (no abortan el archivo completo):
//  - Sin permiso de escritura en la empresa (VIEWER o sin acceso): se omite
//    (misma regla que batch-calcular/batch-timbrar — el archivo expone CLABE,
//    banco, RFC y neto de los empleados).
//  - Empresa sin corrida elegible para el periodo: se omite.
//
// Mismo layout de columnas que /api/nomina/dispersion MÁS una columna inicial
// "Empresa" para que cada renglón sea atribuible. CLABE/Banco se toman del
// empleado cuando están capturados; se dejan vacías si el empleado no los tiene.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;

  const { searchParams } = new URL(req.url);
  const companyIdsRaw = searchParams.get("companyIds");
  const periodoInicio = searchParams.get("periodoInicio");
  const periodoFin = searchParams.get("periodoFin");

  if (!companyIdsRaw) return NextResponse.json({ error: "companyIds requerido" }, { status: 400 });
  if (!periodoInicio || !periodoFin) {
    return NextResponse.json({ error: "periodoInicio y periodoFin requeridos" }, { status: 400 });
  }

  const inicio = new Date(periodoInicio);
  const fin = new Date(periodoFin);
  if (isNaN(inicio.getTime()) || isNaN(fin.getTime())) {
    return NextResponse.json({ error: "Periodo inválido" }, { status: 400 });
  }

  // Gating de suscripción (bandera SUBSCRIPTION_ENFORCEMENT_ENABLED). Aunque es
  // un GET, el archivo SPEI es el ENTREGABLE monetizable de la nómina: se trata
  // como export de valor, no como lectura pasiva.
  const gate = await gateEscritura(userId);
  if (gate) return gate;
  // Misma clave de periodo que createPayrollRun/batch-calcular.
  const periodoKey = `${inicio.toISOString().split("T")[0]}/${fin.toISOString().split("T")[0]}`;

  const ids = Array.from(
    new Set(companyIdsRaw.split(",").map((s) => s.trim()).filter(Boolean))
  );
  if (ids.length === 0) return NextResponse.json({ error: "companyIds requerido" }, { status: 400 });

  // Mismo layout que /api/nomina/dispersion + columna "Empresa" al inicio.
  const header = "Empresa,Num Empleado,Nombre,RFC,CLABE,Banco,Neto a Pagar,Concepto,Referencia";
  const lines: string[] = [];

  for (const companyId of ids) {
    // AUTZ por empresa: misma regla que batch-calcular/batch-timbrar.
    // VIEWER o sin acceso → omitir (datos bancarios sensibles).
    const member = await getEffectiveCompanyMembership(userId, companyId);
    if (!member || member.role === "VIEWER") continue;

    // Corrida más reciente no-DRAFT para ese periodo.
    const run = await prisma.payrollRun.findFirst({
      where: { companyId, periodo: periodoKey, status: { not: "DRAFT" } },
      orderBy: { createdAt: "desc" },
      include: {
        items: {
          include: {
            employee: {
              select: {
                nombre: true, apellidoPaterno: true, apellidoMaterno: true,
                rfc: true, numEmpleado: true, clabe: true, banco: true,
              },
            },
          },
        },
        company: { select: { razonSocial: true, rfc: true } },
      },
    });

    // Sin corrida o con status no dispersable (mismas reglas que el endpoint
    // por corrida): omitir esta empresa sin abortar el archivo.
    if (!run) continue;
    if (!["CALCULATED", "STAMPED", "PAID"].includes(run.status)) continue;

    const empresa = run.company.razonSocial || run.company.rfc;
    const concepto = `Nomina ${run.periodo}`;
    const referencia = run.id.slice(-8);

    for (const item of run.items) {
      const nombre = `${item.employee.apellidoPaterno} ${item.employee.apellidoMaterno ?? ""} ${item.employee.nombre}`.trim();
      const numEmp = item.employee.numEmpleado ?? item.employeeId.slice(-6);
      const clabe = item.employee.clabe ?? "";
      const banco = item.employee.banco ?? "";

      lines.push([
        `"${empresa}"`,
        numEmp,
        `"${nombre}"`,
        item.employee.rfc,
        clabe,
        `"${banco}"`,
        item.netoAPagar.toFixed(2),
        `"${concepto}"`,
        referencia,
      ].join(","));
    }

    // Bitácora de seguridad: una fila por empresa incluida en el archivo
    // (el export en lote también ES un evento). Fire-and-forget.
    registrarBitacora({
      companyId: run.companyId,
      userId,
      actorEmail: session.user.email ?? null,
      accion: "nomina.dispersion-export",
      entidad: "PayrollRun",
      entidadId: run.id,
      detalle: {
        periodo: run.periodo,
        empresaRfc: run.company.rfc,
        empleados: run.items.length,
        lote: true,
      },
      req,
    });
  }

  const csv = [header, ...lines].join("\r\n");
  const periodoSlug = periodoKey.replace(/\//g, "_");
  const filename = `dispersion-despacho-${periodoSlug}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
