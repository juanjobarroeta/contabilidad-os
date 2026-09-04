/**
 * GET  /api/hospital/pagadores?companyId=…[&todos=1]
 * POST /api/hospital/pagadores
 *
 * Convenios (lámina 15). Cada fila trae el receptor fiscal, los episodios
 * activos, los días de vigencia que le quedan y `porCobrar`: la parte del
 * pagador en las cuentas abiertas — el reparto real de cada episodio activo
 * (calcularCuenta sobre sus cargos vivos), no una estimación.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { aFecha, bitacora, error, errorZod } from "@/lib/hospital/http";
import { calcularCuenta } from "@/lib/hospital/cuenta";
import { cargoParaCuenta, customerResumen, pagadorResumen } from "@/lib/hospital/serializar";
import { diasEntre } from "@/lib/hospital/tz";
import { ESTADOS_ACTIVOS, r2 } from "@/lib/hospital/util";
import { pagadorSchema } from "@/lib/hospital/pagador-schema";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const todos = searchParams.get("todos") === "1";
  const [pagadores, config, cargos] = await Promise.all([
    prisma.hospPagador.findMany({
      where: { companyId, ...(todos ? {} : { activo: true }) },
      include: {
        customer: { select: { id: true, razonSocial: true, rfc: true } },
        _count: { select: { episodios: { where: { estado: { in: ESTADOS_ACTIVOS } } }, pacientes: true, tarifas: true } },
      },
      orderBy: [{ tipo: "asc" }, { nombre: "asc" }],
    }),
    prisma.hospConfig.findUnique({ where: { companyId }, select: { topeAutorizacion: true } }),
    prisma.hospCargo.findMany({
      where: { companyId, cancelado: false, episodio: { estado: { in: ESTADOS_ACTIVOS }, pagadorId: { not: null } } },
      select: { id: true, fecha: true, descripcion: true, categoria: true, cantidad: true, precioUnitario: true, ivaTasa: true, importe: true, origen: true, cancelado: true, episodioId: true, episodio: { select: { pagadorId: true } } },
    }),
  ]);

  const porEpisodio = new Map<string, { pagadorId: string; cargos: typeof cargos }>();
  for (const c of cargos) {
    const e = porEpisodio.get(c.episodioId) ?? { pagadorId: c.episodio.pagadorId!, cargos: [] };
    e.cargos.push(c);
    porEpisodio.set(c.episodioId, e);
  }
  const porCobrar = new Map<string, number>();
  const cfg = { topeAutorizacion: config?.topeAutorizacion == null ? null : Number(config.topeAutorizacion) };
  const pagadorPorId = new Map(pagadores.map((p) => [p.id, p]));
  for (const e of porEpisodio.values()) {
    const p = pagadorPorId.get(e.pagadorId);
    if (!p) continue;
    const cuenta = calcularCuenta({ cargos: e.cargos.map(cargoParaCuenta), pagador: pagadorResumen(p), config: cfg });
    porCobrar.set(p.id, r2((porCobrar.get(p.id) ?? 0) + cuenta.reparto.aseguradora));
  }

  const hoy = new Date();
  return NextResponse.json(
    pagadores.map(({ _count, customer, ...p }) => ({
      ...p,
      ...pagadorResumen(p),
      customer: customerResumen(customer),
      episodiosActivos: _count.episodios,
      pacientes: _count.pacientes,
      tarifas: _count.tarifas,
      vigenciaDias: p.vigenciaFin ? diasEntre(hoy, p.vigenciaFin) : null,
      porCobrar: porCobrar.get(p.id) ?? 0,
    }))
  );
});

const createSchema = pagadorSchema.extend({ companyId: z.string().min(1) });

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, vigenciaInicio, vigenciaFin, ...d } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  if (d.customerId) {
    const c = await prisma.customer.findUnique({ where: { id: d.customerId }, select: { companyId: true } });
    if (!c || c.companyId !== companyId) return error("customerId inválido");
  }

  const pagador = await prisma.hospPagador.create({
    data: { companyId, ...d, nombre: d.nombre.trim(), vigenciaInicio: aFecha(vigenciaInicio), vigenciaFin: aFecha(vigenciaFin) },
    include: { customer: { select: { id: true, razonSocial: true, rfc: true } } },
  });
  bitacora(user, req, { companyId, accion: "hospital.pagador.crear", entidad: "HospPagador", entidadId: pagador.id, detalle: { nombre: pagador.nombre, tipo: pagador.tipo } });
  return NextResponse.json({ ...pagador, ...pagadorResumen(pagador), customer: customerResumen(pagador.customer), episodiosActivos: 0, porCobrar: 0 }, { status: 201 });
});
