import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership } from "@/lib/authz";
import {
  acumuladosEmpleado,
  aniosConRecibos,
  type ReciboAcumulable,
} from "@/lib/nomina/acumulados";
import { descargasPorUuid } from "@/lib/nomina/recibos-descarga";
import { normalizarUuid } from "@/lib/fiscal/uuid";

type Params = { params: Promise<{ id: string }> };

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nomina/empleado/[id]?year=&page=&pageSize=
//
// Expediente del empleado — SÓLO LECTURA (cualquier miembro, VIEWER incluido):
//   - datos:       ficha del empleado (nombre, RFC, CURP, NSS, puesto, SBC…)
//   - anios:       ejercicios con recibos (para el selector de año)
//   - acumulados:  totales del ejercicio seleccionado (lib pura acumulados.ts
//                  — misma base que usará el ajuste anual Art. 97)
//   - recibos:     historial paginado del ejercicio, del más reciente al más
//                  antiguo, con la corrida (periodo, origen APP/SAT) y el UUID
//   - cambiosSalario: movimientos IMSS de salario (alta/modificaciones) — el
//                  salario diario por recibo no se persiste, así que el
//                  historial salarial sale de ImssMovimiento, no de derivarlo.
//
// La consulta de recibos queda acotada por empleado-ejercicio (un año de
// quincenas ≈ 24-52 filas), nunca se pagina sobre toda la empresa.
// ─────────────────────────────────────────────────────────────────────────────
export async function GET(req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const url = new URL(req.url);

    const empleado = await prisma.employee.findUnique({
      where: { id },
      select: {
        id: true,
        companyId: true,
        nombre: true,
        apellidoPaterno: true,
        apellidoMaterno: true,
        rfc: true,
        curp: true,
        nss: true,
        numEmpleado: true,
        puesto: true,
        departamento: true,
        salarioDiario: true,
        salarioDiarioIntegrado: true,
        periodicidadPago: true,
        fechaIngreso: true,
        fechaBaja: true,
        isActive: true,
        banco: true,
        clabe: true,
      },
    });
    if (!empleado) return NextResponse.json({ error: "Empleado no encontrado" }, { status: 404 });

    // Cualquier rol con membresía (VIEWER incluido) puede LEER el expediente.
    // Con `req`: sin él, requireUser no ve el bearer y el satélite recibe 401.
    await requireMembership(empleado.companyId, undefined, req);

    // Ejercicios con recibos (fechas de pago de las corridas del empleado).
    const runsConRecibos = await prisma.payrollRun.findMany({
      where: { companyId: empleado.companyId, items: { some: { employeeId: id } } },
      select: { fechaPago: true },
    });
    const anios = aniosConRecibos(runsConRecibos);

    const yearParam = Number(url.searchParams.get("year"));
    const anio = anios.includes(yearParam) ? yearParam : anios[0] ?? new Date().getUTCFullYear();

    // Recibos del ejercicio seleccionado — acotado por empleado-año.
    const desde = new Date(Date.UTC(anio, 0, 1));
    const hasta = new Date(Date.UTC(anio + 1, 0, 1));
    const items = (await prisma.payrollItem.findMany({
      where: {
        employeeId: id,
        payrollRun: { fechaPago: { gte: desde, lt: hasta } },
      },
      include: {
        payrollRun: {
          select: { id: true, periodo: true, fechaPago: true, tipo: true, status: true, origen: true },
        },
      },
      orderBy: [{ payrollRun: { fechaPago: "desc" } }, { id: "asc" }],
    })).map((r) => ({
      ...r,
      sueldoBase: Number(r.sueldoBase), horasExtra: Number(r.horasExtra),
      bonosPagoFijo: Number(r.bonosPagoFijo), bonosPagoVar: Number(r.bonosPagoVar),
      vales: Number(r.vales), otrasPercepciones: Number(r.otrasPercepciones),
      aguinaldo: Number(r.aguinaldo), primaVacacional: Number(r.primaVacacional),
      vacaciones: Number(r.vacaciones), ptu: Number(r.ptu),
      isrRetenido: Number(r.isrRetenido), imssObrero: Number(r.imssObrero),
      imssPatronal: Number(r.imssPatronal), infonavit: Number(r.infonavit),
      otrasDeducc: Number(r.otrasDeducc), totalPercepciones: Number(r.totalPercepciones),
      totalDeducciones: Number(r.totalDeducciones), netoAPagar: Number(r.netoAPagar),
    }));

    const paraAcumular: ReciboAcumulable[] = items.map((i) => ({
      fechaPago: i.payrollRun.fechaPago,
      origen: i.payrollRun.origen,
      sueldoBase: i.sueldoBase,
      horasExtra: i.horasExtra,
      bonosPagoFijo: i.bonosPagoFijo,
      bonosPagoVar: i.bonosPagoVar,
      vales: i.vales,
      otrasPercepciones: i.otrasPercepciones,
      aguinaldo: i.aguinaldo,
      primaVacacional: i.primaVacacional,
      vacaciones: i.vacaciones,
      ptu: i.ptu,
      isrRetenido: i.isrRetenido,
      imssObrero: i.imssObrero,
      infonavit: i.infonavit,
      otrasDeducc: i.otrasDeducc,
      totalPercepciones: i.totalPercepciones,
      totalDeducciones: i.totalDeducciones,
      netoAPagar: i.netoAPagar,
    }));
    const acumulados = acumuladosEmpleado(paraAcumular, anio);

    // Paginación en memoria dentro del ejercicio (≤ ~52 filas por año).
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get("pageSize")) || 25));
    const total = items.length;
    const pagina = items.slice((page - 1) * pageSize, page * pageSize);

    // Descarga del recibo timbrado (PDF/XML): Invoice resuelto por UUID —
    // sólo de la página visible, no de todo el ejercicio.
    const descargas = await descargasPorUuid(empleado.companyId, pagina.map((i) => i.cfdiUuid));

    const recibos = pagina.map((i) => {
      const d = i.cfdiUuid ? descargas.get(normalizarUuid(i.cfdiUuid)) : undefined;
      return {
        id: i.id,
        runId: i.payrollRun.id,
        periodo: i.payrollRun.periodo,
        fechaPago: i.payrollRun.fechaPago,
        tipo: i.payrollRun.tipo,
        status: i.payrollRun.status,
        origen: i.payrollRun.origen,
        sueldoBase: i.sueldoBase,
        totalPercepciones: i.totalPercepciones,
        isrRetenido: i.isrRetenido,
        imssObrero: i.imssObrero,
        infonavit: i.infonavit,
        totalDeducciones: i.totalDeducciones,
        netoAPagar: i.netoAPagar,
        cfdiUuid: i.cfdiUuid,
        invoiceId: d?.invoiceId ?? null,
        pdfDisponible: d?.pdfDisponible ?? false,
        xmlDisponible: d?.xmlDisponible ?? false,
      };
    });

    // Historial salarial: movimientos IMSS de alta / modificación de salario.
    const cambiosSalario = await prisma.imssMovimiento.findMany({
      where: {
        employeeId: id,
        companyId: empleado.companyId,
        tipo: { in: ["ALTA", "REINGRESO", "MODIFICACION_SALARIO"] },
      },
      select: { id: true, tipo: true, fechaMovimiento: true, sbcAnterior: true, sbcNuevo: true, motivo: true },
      orderBy: { fechaMovimiento: "desc" },
      take: 50,
    });

    return NextResponse.json({
      empleado,
      anios,
      anio,
      acumulados,
      recibos: { items: recibos, total, page, pageSize },
      cambiosSalario,
    });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
