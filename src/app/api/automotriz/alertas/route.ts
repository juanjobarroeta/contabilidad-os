import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import {
  detectComplementosPendientes,
  detectComplementosRecibidosPendientes,
} from "@/lib/complementos";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/automotriz/alertas?companyId=…
//
// Bandeja de alertas del satélite (IA §4.5): reúne en una sola respuesta
//   • los hallazgos ABIERTOS del auditor fiscal del hub (FiscalHallazgo:
//     69-B/EFOS, REP, duplicados, obligaciones… — los corre el cron diario),
//   • los complementos de pago pendientes en ambas direcciones (por emitir =
//     obligación RMF 2.7.1.32; por recibir = riesgo de deducción Art. 5-I LIVA),
//   • y las alertas propias del piso: unidades en venta envejeciendo (plan
//     piso) y unidades auto-creadas pendientes de confirmar (POR REVISAR).
//
// Solo lectura. El ciclo de vida de los hallazgos (resolver/ignorar/posponer)
// se gestiona en el hub; aquí cada alerta lleva a su fuente.
// ─────────────────────────────────────────────────────────────────────────────

const DIAS_ATENCION = 90;
const DIAS_CRITICO = 180;
// Umbral de «en piso improbable»: una unidad derivada de CFDIs que lleva 18+
// meses "disponible" casi seguro se vendió sin factura ligable (público en
// general sin VIN). Se confirma a mano con «Marcar vendida» — nunca en bulk
// automático, para no inventar ventas.
const DIAS_IMPROBABLE = 548;
const MS_DIA = 86_400_000;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const now = new Date();
  const [hallazgos, repEmitir, repRecibir, unidadesVivas, porRevisar] = await Promise.all([
    prisma.fiscalHallazgo.findMany({
      where: {
        companyId,
        estado: "ABIERTO",
        OR: [{ posponerHasta: null }, { posponerHasta: { lte: now } }],
      },
      orderBy: [{ severidad: "asc" }, { createdAt: "desc" }],
      select: {
        id: true, checkClave: true, severidad: true, mensaje: true, sugerencia: true,
        fundamentoLey: true, fundamentoArticulo: true, createdAt: true,
      },
    }),
    detectComplementosPendientes(companyId, now),
    detectComplementosRecibidosPendientes(companyId, now),
    prisma.vehiculo.findMany({
      where: {
        companyId,
        estado: { in: ["DISPONIBLE", "APARTADO"] },
        uso: "VENTA",
        fechaCompra: { not: null },
      },
      select: {
        id: true, vin: true, marca: true, modelo: true, anio: true, fechaCompra: true,
        costoCompra: true, planPisoTasaAnual: true, autoCreado: true,
        pedidos: { where: { estado: { in: ["COTIZACION", "APARTADO", "FACTURADO"] } }, select: { id: true }, take: 1 },
      },
    }),
    prisma.vehiculo.count({
      where: {
        companyId,
        autoCreado: true,
        OR: [{ marca: "POR REVISAR" }, { modelo: "POR REVISAR" }],
      },
    }),
  ]);

  const conDias = unidadesVivas.map((v) => {
    const dias = Math.floor((now.getTime() - v.fechaCompra!.getTime()) / MS_DIA);
    // Costo financiero estimado de tener la unidad parada (si hay tasa piso).
    const interesEstimado =
      v.planPisoTasaAnual != null ? Math.round(((Number(v.costoCompra) * Number(v.planPisoTasaAnual) * dias) / 365) * 100) / 100 : null;
    return {
      id: v.id, vin: v.vin, unidad: `${v.marca} ${v.modelo} ${v.anio}`, dias,
      costoCompra: Number(v.costoCompra), interesEstimado,
      improbable: v.autoCreado && v.pedidos.length === 0 && dias >= DIAS_IMPROBABLE,
    };
  });

  // Improbables aparte: no son "aging" real — son unidades cuya venta el CFDI
  // no puede probar. El aging operativo excluye a las improbables para que la
  // señal de precio no se ahogue en el ruido histórico.
  const improbables = conDias.filter((v) => v.improbable).sort((a, b) => b.dias - a.dias);
  const envejecidas = conDias
    .filter((v) => !v.improbable && v.dias >= DIAS_ATENCION)
    .sort((a, b) => b.dias - a.dias);

  return NextResponse.json({
    hallazgos: hallazgos.map((h) => ({
      id: h.id,
      checkClave: h.checkClave,
      categoria: h.checkClave.split(".")[0] || "otros",
      severidad: h.severidad, // info | warn | error
      mensaje: h.mensaje,
      sugerencia: h.sugerencia,
      fundamento: `${h.fundamentoLey} ${h.fundamentoArticulo}`,
      createdAt: h.createdAt,
    })),
    repPorEmitir: {
      ...repEmitir.stats,
      top: repEmitir.pendientes.slice(0, 5),
    },
    repPorRecibir: {
      ...repRecibir.stats,
      top: repRecibir.pendientes.slice(0, 5),
    },
    inventario: {
      diasAtencion: DIAS_ATENCION,
      diasCritico: DIAS_CRITICO,
      envejecidas: envejecidas.slice(0, 10),
      totalEnvejecidas: envejecidas.length,
      criticas: envejecidas.filter((v) => v.dias >= DIAS_CRITICO).length,
      porRevisar,
      improbables: {
        diasUmbral: DIAS_IMPROBABLE,
        total: improbables.length,
        costoTotal: Math.round(improbables.reduce((s, v) => s + v.costoCompra, 0) * 100) / 100,
        top: improbables.slice(0, 15),
      },
    },
  });
});
