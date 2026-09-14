import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/nomina/movimientos?companyId=…[&limit=12]
//
// «Últimos movimientos» del hub de Nómina: lo que PASÓ, en orden, mezclando
// tres fuentes que hoy nadie junta — corridas (timbradas, calculadas,
// finiquitos), altas y bajas de empleados, y las acciones registradas en la
// bitácora (timbrar, dispersión, cancelar timbre, incidencias, expediente).
// Es la portada del hub: antes abría en la validación del cálculo.
//
// Sólo lectura; una consulta por fuente, acotadas, y se mezclan en memoria.
// Además devuelve `especiales`: conteo y neto por tipo de corrida del
// ejercicio (finiquitos, aguinaldo, PTU…), para los chips del Resumen.
// ─────────────────────────────────────────────────────────────────────────────

export interface MovimientoNomina {
  id: string;
  fecha: string;
  /** Qué pasó, en una línea. */
  titulo: string;
  detalle: string | null;
  tipo: "CORRIDA" | "FINIQUITO" | "ALTA" | "BAJA" | "TIMBRADO" | "DISPERSION" | "CANCELACION" | "INCIDENCIA" | "EXPEDIENTE";
  /** A dónde lleva el clic. */
  href: string;
  actor: string | null;
}

const ACCION_TIPO: Record<string, MovimientoNomina["tipo"]> = {
  "nomina.timbrar": "TIMBRADO",
  "nomina.dispersion-export": "DISPERSION",
  "nomina.cancelar-timbre": "CANCELACION",
  "nomina.incidencia.agregar": "INCIDENCIA",
  "nomina.incidencia.eliminar": "INCIDENCIA",
  "nomina.expediente.subir": "EXPEDIENTE",
  "nomina.expediente.eliminar": "EXPEDIENTE",
};
const ACCION_TITULO: Record<string, string> = {
  "nomina.timbrar": "Recibos timbrados",
  "nomina.dispersion-export": "Dispersión generada",
  "nomina.cancelar-timbre": "Timbre cancelado",
  "nomina.incidencia.agregar": "Incidencia registrada",
  "nomina.incidencia.eliminar": "Incidencia eliminada",
  "nomina.expediente.subir": "Documento subido al expediente",
  "nomina.expediente.eliminar": "Documento eliminado del expediente",
};

const fmt = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
  const limit = Math.min(50, Math.max(1, parseInt(searchParams.get("limit") ?? "12", 10) || 12));

  const inicioEjercicio = new Date(new Date().getFullYear(), 0, 1);
  const [runs, altas, bajas, bitacora, especialesRaw] = await Promise.all([
    prisma.payrollRun.findMany({
      where: { companyId },
      select: { id: true, periodo: true, fechaPago: true, tipo: true, status: true, totalNeto: true, createdAt: true, origen: true, _count: { select: { items: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.employee.findMany({
      where: { companyId },
      select: { id: true, nombre: true, apellidoPaterno: true, fechaIngreso: true },
      orderBy: { fechaIngreso: "desc" },
      take: limit,
    }),
    prisma.employee.findMany({
      where: { companyId, isActive: false, fechaBaja: { not: null } },
      select: { id: true, nombre: true, apellidoPaterno: true, fechaBaja: true },
      orderBy: { fechaBaja: "desc" },
      take: limit,
    }),
    prisma.auditLog.findMany({
      where: { companyId, accion: { in: Object.keys(ACCION_TIPO) } },
      select: { id: true, createdAt: true, accion: true, actorEmail: true, detalle: true, entidadId: true },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    prisma.payrollRun.groupBy({
      by: ["tipo"],
      where: { companyId, fechaPago: { gte: inicioEjercicio }, status: { in: ["STAMPED", "PAID"] } },
      _count: { _all: true },
      _sum: { totalNeto: true },
    }),
  ]);

  const movs: MovimientoNomina[] = [];
  for (const r of runs) {
    const esFiniquito = r.tipo === "FINIQUITO";
    const timbrada = r.status === "STAMPED" || r.status === "PAID";
    movs.push({
      id: `run:${r.id}`,
      fecha: r.createdAt.toISOString(),
      tipo: esFiniquito ? "FINIQUITO" : "CORRIDA",
      titulo: esFiniquito ? "Finiquito" : `Corrida ${r.tipo === "ORDINARIA" ? "" : r.tipo.toLowerCase() + " "}${timbrada ? "timbrada" : r.status === "CALCULATED" ? "calculada" : r.status.toLowerCase()}`.replace(/\s+/g, " ").trim(),
      detalle: `${r.periodo} · ${r._count.items} recibo${r._count.items === 1 ? "" : "s"} · neto ${fmt(Number(r.totalNeto))}${r.origen === "SAT" ? " · importada del SAT" : ""}`,
      href: `/nomina?tab=corridas&run=${r.id}`,
      actor: null,
    });
  }
  for (const e of altas) {
    movs.push({ id: `alta:${e.id}`, fecha: e.fechaIngreso.toISOString(), tipo: "ALTA", titulo: "Alta de empleado", detalle: `${e.nombre} ${e.apellidoPaterno}`, href: `/nomina?tab=empleados&empleado=${e.id}`, actor: null });
  }
  for (const e of bajas) {
    if (!e.fechaBaja) continue;
    movs.push({ id: `baja:${e.id}`, fecha: e.fechaBaja.toISOString(), tipo: "BAJA", titulo: "Baja de empleado", detalle: `${e.nombre} ${e.apellidoPaterno}`, href: `/nomina?tab=empleados&empleado=${e.id}`, actor: null });
  }
  for (const b of bitacora) {
    const d = (b.detalle ?? {}) as Record<string, unknown>;
    const partes = [
      typeof d.periodo === "string" ? d.periodo : null,
      typeof d.recibos === "number" ? `${d.recibos} recibo${d.recibos === 1 ? "" : "s"}` : null,
      typeof d.empleado === "string" ? d.empleado : null,
      typeof d.nombre === "string" ? d.nombre : null,
    ].filter(Boolean);
    movs.push({
      id: `log:${b.id}`,
      fecha: b.createdAt.toISOString(),
      tipo: ACCION_TIPO[b.accion],
      titulo: ACCION_TITULO[b.accion] ?? b.accion,
      detalle: partes.length ? partes.join(" · ") : null,
      href: b.accion.startsWith("nomina.expediente") || b.accion.startsWith("nomina.incidencia") ? "/nomina?tab=empleados" : "/nomina?tab=corridas",
      actor: b.actorEmail,
    });
  }
  movs.sort((a, b) => b.fecha.localeCompare(a.fecha));

  const especiales = especialesRaw
    .filter((g) => g.tipo !== "ORDINARIA")
    .map((g) => ({ tipo: g.tipo, corridas: g._count._all, neto: Number(g._sum.totalNeto ?? 0) }))
    .sort((a, b) => b.corridas - a.corridas);

  return NextResponse.json({ movimientos: movs.slice(0, limit), especiales, ejercicio: inicioEjercicio.getFullYear() });
}
