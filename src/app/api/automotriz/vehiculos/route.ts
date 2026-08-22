/**
 * GET  /api/automotriz/vehiculos?companyId=…&estado=…&tipo=…
 * POST /api/automotriz/vehiculos
 *
 * Alta y listado de unidades. El alta NO postea al ledger: la unidad nace
 * EN_TRANSITO y el inventario se postea al recibirla (POST …/[id]/recibir),
 * que es la transición de la máquina de estados que garantiza idempotencia.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { unidadVigentePorVin } from "@/lib/automotriz/unidad-vigente";

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const estado = searchParams.get("estado");
  const tipo = searchParams.get("tipo");

  // Lista LIGERA: sólo los campos que la tabla usa, y los costos como UNA suma
  // agrupada en vez de todas las filas por unidad — con miles de unidades, el
  // include de costos multiplicaba el payload y el tiempo de respuesta.
  const [vehiculos, sumas, interes] = await Promise.all([
    prisma.vehiculo.findMany({
      where: {
        companyId,
        ...(estado ? { estado: estado as never } : {}),
        ...(tipo ? { tipo: tipo as never } : {}),
      },
      select: {
        id: true, vin: true, marca: true, modelo: true, version: true, anio: true,
        tipo: true, estado: true, uso: true, color: true, numeroMotor: true,
        numeroEconomico: true, ciclo: true, costoCompra: true, fechaCompra: true,
        precioVenta: true, fechaVenta: true, ventaInvoiceId: true, autoCreado: true,
        compraInvoiceId: true, planPisoInicio: true, planPisoTasaAnual: true,
        cliente: { select: { id: true, razonSocial: true } },
        supplier: { select: { id: true, razonSocial: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.vehiculoCosto.groupBy({
      by: ["vehiculoId"],
      where: { vehiculo: { companyId } },
      _sum: { monto: true },
    }),
    // El interés de plan piso se devenga a diario como VehiculoCosto; se suma
    // aparte porque la pantalla lo muestra en su propia columna: es el costo
    // de tener metal parado, y mezclarlo con los demás costos lo esconde.
    prisma.vehiculoCosto.groupBy({
      by: ["vehiculoId"],
      where: { vehiculo: { companyId }, tipo: "INTERES_PISO" },
      _sum: { monto: true },
    }),
  ]);

  const costosPorUnidad = new Map(sumas.map((s) => [s.vehiculoId, s._sum.monto ?? 0]));
  const interesPorUnidad = new Map(interes.map((s) => [s.vehiculoId, s._sum.monto ?? 0]));

  // Días en piso: derivado aquí, no en el cliente. Una unidad vendida deja de
  // devengar el día de la venta; una que sigue en piso cuenta hasta hoy. Sin
  // fecha de entrada no se inventa un cero — se devuelve null y la pantalla
  // dice «sin documentar», que es distinto de «cero días».
  const DIA = 86_400_000;
  const ahora = Date.now();
  const diasEnPiso = (v: { planPisoInicio: Date | null; fechaCompra: Date | null; fechaVenta: Date | null }) => {
    const inicio = v.planPisoInicio ?? v.fechaCompra;
    if (!inicio) return null;
    const fin = v.fechaVenta ? v.fechaVenta.getTime() : ahora;
    return Math.max(0, Math.floor((fin - inicio.getTime()) / DIA));
  };

  return NextResponse.json(
    vehiculos.map((v) => ({
      ...v,
      costosTotal: costosPorUnidad.get(v.id) ?? 0,
      interesPiso: interesPorUnidad.get(v.id) ?? 0,
      diasEnPiso: diasEnPiso(v),
    }))
  );
});

const createSchema = z.object({
  companyId: z.string().min(1),
  vin: z
    .string()
    .min(11)
    .max(17)
    .transform((v) => v.trim().toUpperCase()),
  marca: z.string().min(1).max(60),
  modelo: z.string().min(1).max(60),
  version: z.string().max(80).nullable().optional(),
  anio: z.number().int().min(1990).max(2100),
  color: z.string().max(40).nullable().optional(),
  numeroEconomico: z.string().max(20).nullable().optional(),
  tipo: z.enum(["NUEVO", "SEMINUEVO"]).default("NUEVO"),
  kilometraje: z.number().int().min(0).nullable().optional(),
  costoCompra: z.number().min(0).default(0),
  compraInvoiceId: z.string().nullable().optional(),
  supplierId: z.string().nullable().optional(),
  planPisoTasaAnual: z.number().min(0).max(2).nullable().optional(),
  precioLista: z.number().min(0).nullable().optional(),
  notas: z.string().max(2000).nullable().optional(),
});

export const POST = withAuthz(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { companyId, compraInvoiceId, supplierId, ...data } = parsed.data;

  await requireWriter(companyId, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  // Alta manual: sigue bloqueando si el VIN ya existe en la empresa. Los
  // ciclos de recompra los abre HOY sólo la derivación automática; permitir
  // abrirlos a mano es una decisión de producto aparte.
  const dup = await unidadVigentePorVin(prisma, companyId, data.vin, { id: true });
  if (dup) {
    return NextResponse.json(
      { error: `Ya existe una unidad con VIN ${data.vin}` },
      { status: 409 }
    );
  }

  // FKs canónicos: verificar que pertenecen a la misma empresa (fail-closed).
  if (compraInvoiceId) {
    const inv = await prisma.invoice.findUnique({
      where: { id: compraInvoiceId },
      select: { companyId: true },
    });
    if (!inv || inv.companyId !== companyId) {
      return NextResponse.json({ error: "compraInvoiceId inválido" }, { status: 400 });
    }
  }
  if (supplierId) {
    const sup = await prisma.supplier.findUnique({
      where: { id: supplierId },
      select: { companyId: true },
    });
    if (!sup || sup.companyId !== companyId) {
      return NextResponse.json({ error: "supplierId inválido" }, { status: 400 });
    }
  }

  const vehiculo = await prisma.vehiculo.create({
    data: { companyId, compraInvoiceId, supplierId, ...data },
  });
  return NextResponse.json(vehiculo, { status: 201 });
});
