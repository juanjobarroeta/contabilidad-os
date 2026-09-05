import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";
import { banderasControl, exigeLibroControl } from "@/lib/hospital/controlados";

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/hospital/farmacia/insumos/[id]
//
// Edita la ficha del insumo: nombre, presentación, unidad, categoría,
// controlado, grupo de control (LGS 234/245), registro sanitario, sustancia
// activa, cadena de frío, mínimo, precio de venta, tasa de IVA y activo. La
// CLAVE no se edita (es la identidad con la que empata la derivación desde
// CFDIs) y la existencia no se toca aquí: eso es un movimiento (AJUSTE) con
// su motivo. Al fijar `grupoControl` sin mandar `controlado`, la bandera se
// deriva del grupo (I-III = controlado). La empresa es la del propio insumo
// (404 si no existe).
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORIAS = ["MEDICAMENTO", "MATERIAL_CURACION", "SOLUCION", "EQUIPO", "REACTIVO", "OTRO"] as const;
const GRUPOS = ["I", "II", "III", "IV", "V", "VI"] as const;

const patchSchema = z
  .object({
    nombre: z.string().trim().min(1).max(200).optional(),
    presentacion: z.string().trim().max(120).nullable().optional(),
    unidad: z.string().trim().min(1).max(30).optional(),
    categoria: z.enum(CATEGORIAS).optional(),
    controlado: z.boolean().optional(),
    grupoControl: z.enum(GRUPOS).nullable().optional(),
    registroSanitario: z.string().trim().max(60).nullable().optional(),
    sustanciaActiva: z.string().trim().max(120).nullable().optional(),
    requiereRefrigeracion: z.boolean().optional(),
    minimo: z.number().min(0).max(1_000_000).optional(),
    precioVenta: z.number().min(0).nullable().optional(),
    ivaTasa: z.number().min(0).max(1).nullable().optional(),
    claveProdServ: z.string().trim().max(10).nullable().optional(),
    activo: z.boolean().optional(),
  })
  .strict();

export const PATCH = withAuthz(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Datos inválidos";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "Nada que actualizar" }, { status: 400 });
  }

  const insumo = await prisma.hospInsumo.findUnique({ where: { id }, select: { companyId: true, clave: true } });
  if (!insumo) throw new AuthzError(404, "Insumo no encontrado");

  const { user } = await requireWriter(insumo.companyId, req);
  await requireModule(insumo.companyId, "HOSPITAL", req);

  const data = { ...parsed.data };
  if (data.grupoControl !== undefined && data.controlado === undefined) {
    data.controlado = exigeLibroControl(data.grupoControl);
  }

  const actualizado = await prisma.hospInsumo.update({ where: { id }, data });

  registrarBitacora({
    companyId: insumo.companyId,
    userId: user.id,
    actorEmail: user.email,
    accion: "hospital.insumo.editar",
    entidad: "HospInsumo",
    entidadId: id,
    detalle: { clave: insumo.clave, campos: Object.keys(data), ...(data.grupoControl !== undefined ? { grupoControl: data.grupoControl } : {}) },
    req,
  });

  return NextResponse.json({
    ...actualizado,
    ...banderasControl(actualizado.grupoControl),
    minimo: Number(actualizado.minimo),
    precioVenta: actualizado.precioVenta == null ? null : Number(actualizado.precioVenta),
    ultimoCosto: actualizado.ultimoCosto == null ? null : Number(actualizado.ultimoCosto),
    ivaTasa: actualizado.ivaTasa == null ? null : Number(actualizado.ivaTasa),
  });
});
