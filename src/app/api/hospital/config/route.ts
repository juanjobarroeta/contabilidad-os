import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { conteosDerivacion, leerProgresoInsumos } from "@/lib/hospital/insumos-cfdi";

// ─────────────────────────────────────────────────────────────────────────────
// GET/PUT /api/hospital/config?companyId=…
//
// Configuración del vertical por empresa: nombre comercial que enseña el
// satélite, series de folio (HOSP/COT/MANT), ventana de alerta de caducidad de
// farmacia, tope de autorización default y el IVA default de los servicios.
// GET contesta los defaults cuando la empresa aún no guardó nada, y trae el
// estado de la DERIVACIÓN de farmacia desde CFDIs (para la pantalla de
// Configuración: cuántos insumos/movimientos nacieron del archivo y dónde va
// el cursor).
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  serieEpisodio: "HOSP",
  serieCotizacion: "COT",
  serieTicket: "MANT",
  diasAlertaCaducidad: 90,
  topeAutorizacion: null as number | null,
  ivaServicios: 0.16,
};

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const [config, company, progreso, conteos] = await Promise.all([
    prisma.hospConfig.findUnique({ where: { companyId } }),
    prisma.company.findUnique({ where: { id: companyId }, select: { nombreComercial: true, razonSocial: true } }),
    leerProgresoInsumos(prisma, companyId),
    conteosDerivacion(prisma, companyId),
  ]);

  const nombreDefault = company?.nombreComercial ?? company?.razonSocial ?? null;
  const cuerpo = config
    ? {
        id: config.id,
        companyId,
        nombreHospital: config.nombreHospital ?? nombreDefault,
        serieEpisodio: config.serieEpisodio,
        serieCotizacion: config.serieCotizacion,
        serieTicket: config.serieTicket,
        diasAlertaCaducidad: config.diasAlertaCaducidad,
        topeAutorizacion: config.topeAutorizacion == null ? null : Number(config.topeAutorizacion),
        ivaServicios: Number(config.ivaServicios),
        guardada: true,
        updatedAt: config.updatedAt,
      }
    : { id: null, companyId, nombreHospital: nombreDefault, ...DEFAULTS, guardada: false, updatedAt: null };

  return NextResponse.json({
    ...cuerpo,
    derivacion: { ...conteos, progreso },
  });
});

const putSchema = z.object({
  companyId: z.string().min(1),
  nombreHospital: z.string().trim().max(120).nullable().optional(),
  serieEpisodio: z.string().trim().min(1).max(10).regex(/^[A-Z0-9]+$/i, "Sólo letras y números").optional(),
  serieCotizacion: z.string().trim().min(1).max(10).regex(/^[A-Z0-9]+$/i, "Sólo letras y números").optional(),
  serieTicket: z.string().trim().min(1).max(10).regex(/^[A-Z0-9]+$/i, "Sólo letras y números").optional(),
  diasAlertaCaducidad: z.number().int().min(1).max(730).optional(),
  topeAutorizacion: z.number().min(0).nullable().optional(),
  ivaServicios: z.number().min(0).max(1).optional(),
});

export const PUT = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Datos inválidos";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const { companyId, ...datos } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const limpio = {
    ...datos,
    ...(datos.serieEpisodio ? { serieEpisodio: datos.serieEpisodio.toUpperCase() } : {}),
    ...(datos.serieCotizacion ? { serieCotizacion: datos.serieCotizacion.toUpperCase() } : {}),
    ...(datos.serieTicket ? { serieTicket: datos.serieTicket.toUpperCase() } : {}),
    ...(datos.nombreHospital !== undefined ? { nombreHospital: datos.nombreHospital || null } : {}),
  };
  const config = await prisma.hospConfig.upsert({
    where: { companyId },
    create: { companyId, ...limpio },
    update: limpio,
  });

  registrarBitacora({
    companyId,
    userId: user.id,
    actorEmail: user.email,
    accion: "hospital.config.guardar",
    entidad: "HospConfig",
    entidadId: config.id,
    detalle: { campos: Object.keys(limpio) },
    req,
  });

  return NextResponse.json({
    ...config,
    topeAutorizacion: config.topeAutorizacion == null ? null : Number(config.topeAutorizacion),
    ivaServicios: Number(config.ivaServicios),
    guardada: true,
  });
});
