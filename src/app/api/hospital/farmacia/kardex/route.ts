/**
 * GET /api/hospital/farmacia/kardex?companyId=…&insumoId=…
 *
 * El kardex de un insumo: existencia (Σ movimientos), sus lotes y los últimos
 * 200 movimientos con lo que los explica — el lote, el episodio/paciente al
 * que se aplicó, el CFDI de compra o venta que lo derivó, el motivo, quién
 * lo capturó y, en controlados, la receta y el prescriptor que amparan cada
 * salida. El insumo trae `exigeLibroControl` / `exigeRecetaEspecial` por su
 * grupo y `requiereRefrigeracion` / `registroSanitario` tal cual. Sólo lectura.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { diasDesde, r2 } from "@/lib/hospital/cobranza";
import { nombrePaciente } from "@/lib/hospital/formato";
import { banderasControl } from "@/lib/hospital/controlados";

const MAX_MOVIMIENTOS = 200;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const insumoId = searchParams.get("insumoId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  if (!insumoId) return NextResponse.json({ error: "insumoId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const insumo = await prisma.hospInsumo.findFirst({ where: { id: insumoId, companyId } });
  if (!insumo) throw new AuthzError(404, "Insumo no encontrado");

  const hoy = new Date();
  const [config, suma, lotes, movimientos, total] = await Promise.all([
    prisma.hospConfig.findUnique({ where: { companyId }, select: { diasAlertaCaducidad: true } }),
    prisma.hospMovimientoInsumo.aggregate({ where: { insumoId }, _sum: { cantidad: true } }),
    prisma.hospLote.findMany({
      where: { insumoId },
      select: { id: true, lote: true, caducidad: true, existencia: true, costoUnitario: true, recibidoAt: true, invoiceId: true, supplierId: true },
      orderBy: [{ caducidad: { sort: "asc", nulls: "last" } }],
    }),
    prisma.hospMovimientoInsumo.findMany({
      where: { insumoId },
      orderBy: [{ fecha: "desc" }, { createdAt: "desc" }],
      take: MAX_MOVIMIENTOS,
      select: {
        id: true, fecha: true, tipo: true, cantidad: true, costoUnitario: true, referencia: true,
        usuarioNombre: true, createdAt: true, cargoId: true,
        recetaRef: true, prescriptorNombre: true, prescriptorCedula: true,
        lote: { select: { id: true, lote: true, caducidad: true } },
        episodio: {
          select: { id: true, folio: true, paciente: { select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true } } },
        },
        invoice: {
          select: { id: true, uuid: true, serie: true, folio: true, tipo: true, contraparteNombre: true, customer: { select: { razonSocial: true } } },
        },
      },
    }),
    prisma.hospMovimientoInsumo.count({ where: { insumoId } }),
  ]);

  const diasAlerta = config?.diasAlertaCaducidad ?? 90;
  return NextResponse.json({
    insumo: {
      ...insumo,
      ...banderasControl(insumo.grupoControl),
      minimo: Number(insumo.minimo),
      precioVenta: insumo.precioVenta == null ? null : Number(insumo.precioVenta),
      ultimoCosto: insumo.ultimoCosto == null ? null : Number(insumo.ultimoCosto),
      ivaTasa: insumo.ivaTasa == null ? null : Number(insumo.ivaTasa),
    },
    existencia: r2(Number(suma._sum.cantidad ?? 0)),
    lotes: lotes.map((l) => {
      const dias = l.caducidad ? diasDesde(hoy, l.caducidad) : null;
      return {
        ...l,
        existencia: r2(Number(l.existencia)),
        costoUnitario: Number(l.costoUnitario),
        diasParaCaducar: dias,
        estado: dias == null ? "EN_NIVEL" : dias < 0 ? "CADUCADO" : dias <= diasAlerta ? "CADUCA" : "EN_NIVEL",
      };
    }),
    totalMovimientos: total,
    movimientos: movimientos.map((m) => ({
      id: m.id,
      fecha: m.fecha,
      tipo: m.tipo,
      cantidad: Number(m.cantidad),
      costoUnitario: m.costoUnitario == null ? null : Number(m.costoUnitario),
      lote: m.lote,
      episodio: m.episodio ? { id: m.episodio.id, folio: m.episodio.folio, paciente: nombrePaciente(m.episodio.paciente) } : null,
      invoice: m.invoice
        ? {
            id: m.invoice.id,
            uuid: m.invoice.uuid,
            serie: m.invoice.serie,
            folio: m.invoice.folio,
            tipo: m.invoice.tipo,
            contraparte: m.invoice.customer?.razonSocial ?? m.invoice.contraparteNombre ?? null,
          }
        : null,
      cargoId: m.cargoId,
      recetaRef: m.recetaRef,
      prescriptorNombre: m.prescriptorNombre,
      prescriptorCedula: m.prescriptorCedula,
      referencia: m.referencia,
      usuarioNombre: m.usuarioNombre,
      createdAt: m.createdAt,
    })),
  });
});
