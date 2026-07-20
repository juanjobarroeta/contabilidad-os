import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireModule, requireWriter, withAuthz } from "@/lib/authz";
import { postGastoPurificadora, postVentaPurificadora } from "@/lib/accounting/postings";
import { corteInclude } from "@/lib/purificadora/cortes";

type Params = { params: Promise<{ id: string }> };

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// POST /api/purificadora/cortes/[id]/confirmar
//
// Convierte el corte BORRADOR en movimientos reales, en una transacción:
//   - Por ruta: una venta COBRADA en EFECTIVO y/o una en TRANSFERENCIA
//     (los garrafones se prorratean entre ambas por importe).
//   - Por empresa: una venta a CREDITO (estado PENDIENTE) con una partida por
//     sucursal, al precio pactado del cliente (PurifClienteConfig) o al precio
//     de lista (PurifConfig.precioGarrafon).
//   - Por gasto capturado: un PurifGasto con su asiento.
//   - Cortesías: sólo estadística del corte; no generan venta ni asiento.
export const POST = withAuthz(async (req: Request, ctx: Params) => {
  const { id } = await ctx.params;

  const corte = await prisma.purifCorte.findUnique({
    where: { id },
    include: {
      rutas: { include: { ruta: { select: { nombre: true } } } },
      empresas: {
        include: {
          customer: { select: { id: true, razonSocial: true } },
          sucursal: { select: { id: true, nombre: true } },
        },
      },
      gastos: true,
    },
  });
  if (!corte) throw new AuthzError(404, "Corte no encontrado");

  await requireWriter(corte.companyId, req);
  await requireModule(corte.companyId, "PURIFICADORA", req);

  if (corte.estado !== "BORRADOR") {
    return NextResponse.json({ error: "El corte ya está confirmado" }, { status: 422 });
  }

  const companyId = corte.companyId;
  const fecha = corte.fecha;
  const fechaLabel = fecha.toISOString().slice(0, 10);

  const [config, clienteConfigs] = await Promise.all([
    prisma.purifConfig.findUnique({ where: { companyId } }),
    prisma.purifClienteConfig.findMany({ where: { companyId } }),
  ]);
  const precioLista = config?.precioGarrafon ?? 15;
  const precioPorCliente = new Map(clienteConfigs.map((c) => [c.customerId, c.precioGarrafon]));

  // ── Armar las ventas a crear (fuera de la tx; sólo lectura) ────────────────
  type VentaPlan = {
    customerId: string | null;
    formaPago: "EFECTIVO" | "TRANSFERENCIA" | "CREDITO";
    estado: "COBRADA" | "PENDIENTE";
    descripcion: string;
    items: {
      descripcion: string;
      cantidad: number;
      precioUnitario: number;
      importe: number;
      garrafones: number;
      sucursalId: string | null;
    }[];
  };
  const planes: VentaPlan[] = [];

  // 1. Rutas (casas): venta EFECTIVO y/o TRANSFERENCIA por ruta.
  for (const linea of corte.rutas) {
    const totalRuta = linea.efectivo + linea.transferencia;
    if (!(totalRuta > 0)) continue;
    const partes: Array<{ formaPago: "EFECTIVO" | "TRANSFERENCIA"; importe: number }> = [];
    if (linea.efectivo > 0) partes.push({ formaPago: "EFECTIVO", importe: linea.efectivo });
    if (linea.transferencia > 0)
      partes.push({ formaPago: "TRANSFERENCIA", importe: linea.transferencia });

    let garrafonesRestantes = linea.garrafones;
    partes.forEach((parte, idx) => {
      const esUltima = idx === partes.length - 1;
      const garrafones = esUltima
        ? garrafonesRestantes
        : Math.round(linea.garrafones * (parte.importe / totalRuta));
      garrafonesRestantes -= garrafones;
      const cantidad = garrafones > 0 ? garrafones : 1;
      planes.push({
        customerId: null,
        formaPago: parte.formaPago,
        estado: "COBRADA",
        descripcion: `Corte ${fechaLabel} — ruta ${linea.ruta.nombre} (casas)`,
        items: [
          {
            descripcion: `Venta en ruta ${linea.ruta.nombre} (casas)`,
            cantidad,
            precioUnitario: round2(parte.importe / cantidad),
            importe: round2(parte.importe),
            garrafones,
            sucursalId: null,
          },
        ],
      });
    });
  }

  // 2. Empresas: una venta a crédito por cliente con partida por sucursal.
  const porCliente = new Map<string, typeof corte.empresas>();
  for (const linea of corte.empresas) {
    const list = porCliente.get(linea.customerId) ?? [];
    list.push(linea);
    porCliente.set(linea.customerId, list);
  }
  for (const [customerId, lineas] of porCliente) {
    const precio = precioPorCliente.get(customerId) ?? precioLista;
    const items = lineas.map((l) => ({
      descripcion: l.sucursal?.nombre ?? "Entrega",
      cantidad: l.garrafones,
      precioUnitario: precio,
      importe: round2(l.garrafones * precio),
      garrafones: l.garrafones,
      sucursalId: l.sucursalId ?? null,
    }));
    planes.push({
      customerId,
      formaPago: "CREDITO",
      estado: "PENDIENTE",
      descripcion: `Corte ${fechaLabel} — ${lineas[0].customer.razonSocial}`,
      items,
    });
  }

  // ── Folios consecutivos + transacción ──────────────────────────────────────
  for (let intento = 0; intento < 3; intento++) {
    const last = await prisma.purifVenta.findFirst({
      where: { companyId, folio: { startsWith: "V-" } },
      orderBy: { createdAt: "desc" },
      select: { folio: true },
    });
    let nextNum = (last ? parseInt(last.folio.replace("V-", "")) || 0 : 0) + 1;

    try {
      const result = await prisma.$transaction(async (tx) => {
        const ventaIds: string[] = [];
        for (const plan of planes) {
          const subtotal = round2(plan.items.reduce((s, i) => s + i.importe, 0));
          const garrafones = plan.items.reduce((s, i) => s + i.garrafones, 0);
          const folio = `V-${String(nextNum++).padStart(4, "0")}`;
          const venta = await tx.purifVenta.create({
            data: {
              companyId,
              corteId: corte.id,
              folio,
              fecha,
              customerId: plan.customerId,
              formaPago: plan.formaPago,
              estado: plan.estado,
              subtotal,
              iva: 0,
              total: subtotal,
              garrafones,
              items: { create: plan.items },
            },
          });
          ventaIds.push(venta.id);

          await postVentaPurificadora(tx, {
            companyId,
            ventaId: venta.id,
            descripcion: `Venta ${folio} — ${plan.descripcion}`,
            subtotal,
            iva: 0,
            formaPago: plan.formaPago,
            fecha,
          });
        }

        for (const g of corte.gastos) {
          const gasto = await tx.purifGasto.create({
            data: {
              companyId,
              fecha,
              categoria: g.categoria,
              descripcion: g.descripcion,
              monto: g.monto,
              formaPago: g.formaPago,
              notas: `Corte ${fechaLabel}`,
            },
          });
          await postGastoPurificadora(tx, {
            companyId,
            gastoId: gasto.id,
            descripcion: `Gasto purificadora — ${g.descripcion}`,
            monto: g.monto,
            formaPago: g.formaPago,
            fecha,
          });
        }

        await tx.purifCorte.update({
          where: { id: corte.id },
          data: { estado: "CONFIRMADO", confirmadoAt: new Date() },
        });

        // Tickets de ventanilla del día: quedan INTEGRADOS a este corte.
        // Minerva ya revisó el resumen de ventanilla (el renglón de ruta
        // VENTANILLA del corte); el ingreso viaja por las ventas de ruta.
        await tx.purifTicket.updateMany({
          where: { companyId, fecha, estado: "REGISTRADO" },
          data: { estado: "INTEGRADO", corteId: corte.id },
        });

        return ventaIds;
      });

      const confirmado = await prisma.purifCorte.findUnique({
        where: { id: corte.id },
        include: corteInclude,
      });
      return NextResponse.json({ corte: confirmado, ventasCreadas: result.length });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === "P2002" &&
        intento < 2
      ) {
        continue; // choque de folio por carrera — reintenta con folios frescos
      }
      throw e;
    }
  }
  return NextResponse.json({ error: "No se pudo asignar folio, reintenta" }, { status: 409 });
});
