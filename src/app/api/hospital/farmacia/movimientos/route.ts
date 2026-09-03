import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { registrarBitacora } from "@/lib/audit";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/hospital/farmacia/movimientos
//   { companyId, insumoId, loteId?, tipo: AJUSTE|MERMA|CADUCIDAD|DEVOLUCION, cantidad, motivo, fecha? }
//
// Movimientos de piso que NO nacen de un CFDI ni de una aplicación al
// paciente: el conteo físico (AJUSTE, con signo), la merma, la baja por
// caducidad y la devolución al proveedor (siempre salidas: se guardan en
// negativo aunque lleguen en positivo). Todo movimiento lleva `motivo`, que
// queda en `referencia` — es lo que después explica el kardex.
//
// Con `loteId` se descuenta del saldo materializado del lote; un lote no
// puede quedar en negativo (409). Sin lote, una salida tampoco puede dejar
// la existencia total del insumo en negativo (409).
// ─────────────────────────────────────────────────────────────────────────────

const r2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 1e-6;

const schema = z.object({
  companyId: z.string().min(1),
  insumoId: z.string().min(1),
  loteId: z.string().min(1).nullable().optional(),
  tipo: z.enum(["AJUSTE", "MERMA", "CADUCIDAD", "DEVOLUCION"]),
  cantidad: z.number().max(10_000_000).min(-10_000_000).refine((n) => n !== 0, "La cantidad no puede ser cero"),
  motivo: z.string().trim().min(3, "Indica el motivo").max(300),
  fecha: z
    .string()
    .trim()
    .refine((s) => !Number.isNaN(new Date(s).getTime()), "Fecha inválida")
    .transform((s) => new Date(s))
    .optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.message ?? "Datos inválidos";
    return NextResponse.json({ error: first }, { status: 400 });
  }
  const { companyId, insumoId, tipo, motivo } = parsed.data;
  const loteId = parsed.data.loteId ?? null;
  const fecha = parsed.data.fecha ?? new Date();
  // AJUSTE lleva el signo que trae; lo demás siempre sale.
  const cantidad = tipo === "AJUSTE" ? parsed.data.cantidad : -Math.abs(parsed.data.cantidad);

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const insumo = await prisma.hospInsumo.findFirst({
    where: { id: insumoId, companyId },
    select: { id: true, clave: true, nombre: true, ultimoCosto: true },
  });
  if (!insumo) throw new AuthzError(404, "Insumo no encontrado");

  const resultado = await prisma.$transaction(async (tx) => {
    let lote: { id: string; lote: string; existencia: number; costoUnitario: number } | null = null;
    if (loteId) {
      const l = await tx.hospLote.findFirst({
        where: { id: loteId, insumoId, companyId },
        select: { id: true, lote: true, existencia: true, costoUnitario: true },
      });
      if (!l) throw new AuthzError(404, "Lote no encontrado para este insumo");
      const nueva = Number(l.existencia) + cantidad;
      if (nueva < -EPS) {
        throw new AuthzError(
          409,
          `El lote ${l.lote} tiene ${r2(Number(l.existencia))} y el movimiento pide ${r2(-cantidad)}`
        );
      }
      lote = { id: l.id, lote: l.lote, existencia: r2(nueva), costoUnitario: Number(l.costoUnitario) };
    } else if (cantidad < 0) {
      const suma = await tx.hospMovimientoInsumo.aggregate({ where: { insumoId }, _sum: { cantidad: true } });
      const existencia = Number(suma._sum.cantidad ?? 0);
      if (existencia + cantidad < -EPS) {
        throw new AuthzError(409, `La existencia es ${r2(existencia)} y el movimiento pide ${r2(-cantidad)}`);
      }
    }

    const movimiento = await tx.hospMovimientoInsumo.create({
      data: {
        companyId,
        insumoId,
        loteId: lote?.id ?? null,
        tipo,
        cantidad,
        costoUnitario: lote?.costoUnitario ?? (insumo.ultimoCosto == null ? null : Number(insumo.ultimoCosto)),
        fecha,
        referencia: motivo,
        usuarioId: user.id,
        usuarioNombre: user.name ?? user.email ?? null,
      },
    });
    if (lote) {
      await tx.hospLote.update({ where: { id: lote.id }, data: { existencia: lote.existencia } });
    }
    const suma = await tx.hospMovimientoInsumo.aggregate({ where: { insumoId }, _sum: { cantidad: true } });
    return { movimiento, lote, existencia: r2(Number(suma._sum.cantidad ?? 0)) };
  });

  registrarBitacora({
    companyId,
    userId: user.id,
    actorEmail: user.email,
    accion: "hospital.insumo.movimiento",
    entidad: "HospMovimientoInsumo",
    entidadId: resultado.movimiento.id,
    detalle: { insumoId, clave: insumo.clave, tipo, cantidad, loteId, motivo },
    req,
  });

  return NextResponse.json(
    {
      movimiento: {
        ...resultado.movimiento,
        cantidad: Number(resultado.movimiento.cantidad),
        costoUnitario:
          resultado.movimiento.costoUnitario == null ? null : Number(resultado.movimiento.costoUnitario),
      },
      lote: resultado.lote ? { id: resultado.lote.id, lote: resultado.lote.lote, existencia: resultado.lote.existencia } : null,
      existencia: resultado.existencia,
    },
    { status: 201 }
  );
});
