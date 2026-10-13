/**
 * GET /api/hospital/cotizaciones/crm?companyId=…[&desde=YYYY-MM-DD&hasta=YYYY-MM-DD]
 *
 * Tablero comercial de las cotizaciones creadas en el periodo (default: los
 * últimos 90 días) más TODAS las que siguen abiertas, aunque sean más viejas:
 * KPIs (abiertas, ganadas, perdidas, tasa de cierre, días a cierre), a quién
 * toca llamar hoy, por médico, por responsable, por origen y motivos de
 * pérdida. Ver src/lib/hospital/cotizacion-crm.ts.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { nombreCompleto } from "@/lib/hospital/util";
import { ABIERTAS, equipoComercial, tableroCrm } from "@/lib/hospital/cotizacion-crm";

const fecha = (s: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : null);

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const hoy = new Date();
  const desde = fecha(searchParams.get("desde")) ?? new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate() - 90);
  const hastaDia = fecha(searchParams.get("hasta"));
  const hasta = hastaDia ? new Date(hastaDia.getTime() + 86_400_000) : new Date(hoy.getTime() + 86_400_000);

  const filas = await prisma.hospCotizacion.findMany({
    where: { companyId, OR: [{ createdAt: { gte: desde, lt: hasta } }, { estado: { in: [...ABIERTAS] } }] },
    select: {
      id: true, folio: true, estado: true, procedimiento: true, total: true, createdAt: true, enviadaAt: true, cerradaAt: true, vigenciaHasta: true,
      proximoSeguimiento: true, responsableUserId: true, contactoTelefono: true, origen: true, motivoPerdida: true, perdidaContra: true,
      pacienteNombre: true, dirigidaA: true,
      paciente: { select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true } },
      medico: { select: { id: true, nombre: true } },
      seguimientos: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 2000,
  });

  const tablero = tableroCrm(
    filas.map((c) => ({
      id: c.id, folio: c.folio, estado: c.estado, procedimiento: c.procedimiento, total: Number(c.total), createdAt: c.createdAt,
      enviadaAt: c.enviadaAt, cerradaAt: c.cerradaAt, vigenciaHasta: c.vigenciaHasta, proximoSeguimiento: c.proximoSeguimiento,
      responsableUserId: c.responsableUserId, medico: c.medico, contactoTelefono: c.contactoTelefono, origen: c.origen,
      motivoPerdida: c.motivoPerdida, perdidaContra: c.perdidaContra,
      para: (c.paciente ? nombreCompleto(c.paciente) : c.pacienteNombre) || c.medico?.nombre || c.dirigidaA || "—",
      ultimoSeguimiento: c.seguimientos[0]?.createdAt ?? null,
    })),
    hoy
  );
  const equipo = await equipoComercial(prisma, companyId);
  const nombreDe = new Map(equipo.map((u) => [u.userId, u.nombre]));
  return NextResponse.json({
    desde: desde.toISOString(), hasta: hasta.toISOString(), equipo, ...tablero,
    porResponsable: tablero.porResponsable.map((g) => ({ ...g, nombre: g.clave === "SIN" ? "Sin responsable" : nombreDe.get(g.clave) ?? "Usuario dado de baja" })),
  });
});
