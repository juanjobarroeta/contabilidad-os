/**
 * GET /api/salameria/panel?companyId=...
 *
 * El tablero de dirección. Está armado alrededor de las cuatro formas en que
 * este negocio pierde dinero, no alrededor de las cifras que se ven bonitas:
 *
 *   1. CADUCIDAD — mercancía comprada que se va a echar a perder. El valor de
 *      lo que vence en la ventana de alerta es dinero que ya se pagó y que
 *      todavía se puede rematar; el vencido ya es pérdida.
 *   2. QUIEBRE — publicado sin stock y sin precio. Un producto que la tienda
 *      enseña y no puede vender es tráfico pagado que se va sin comprar.
 *   3. CONTENEDOR EN TRÁNSITO — dinero fuera del negocio que todavía no es
 *      inventario.
 *   4. PEDIDOS ATORADOS — pagados sin surtir, surtidos sin entregar.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";

const r2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) {
    return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "SALAMERIA", req);

  const cfg = await prisma.salConfig.findUnique({
    where: { companyId },
    select: { diasAlertaCaducidad: true },
  });
  const diasAlerta = cfg?.diasAlertaCaducidad ?? 90;

  const ahora = new Date();
  const corteCaducidad = new Date(ahora.getTime() + diasAlerta * 86_400_000);
  const inicioMes = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
  const inicioDia = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate());

  const [
    lotes,
    productos,
    importaciones,
    pedidosMes,
    porSurtir,
    porEnviar,
    listaPublica,
  ] = await Promise.all([
    prisma.salLote.findMany({
      where: { companyId, cantidad: { gt: 0 } },
      select: {
        cantidad: true,
        costoUnitario: true,
        caducidad: true,
        producto: { select: { id: true, sku: true, nombre: true } },
      },
    }),
    prisma.salProducto.findMany({
      where: { companyId, activo: true },
      select: {
        id: true,
        sku: true,
        nombre: true,
        stock: true,
        stockMinimo: true,
        publicado: true,
        preventa: true,
      },
    }),
    prisma.salImportacion.findMany({
      where: { companyId, estado: { in: ["EN_TRANSITO", "EN_ADUANA"] } },
      select: {
        id: true,
        folio: true,
        estado: true,
        fechaLlegada: true,
        tipoCambio: true,
        items: { select: { cantidad: true, precioMoneda: true } },
        costos: { select: { importe: true, prorratea: true } },
      },
    }),
    prisma.salPedido.findMany({
      where: {
        companyId,
        estado: { notIn: ["CARRITO", "CANCELADO"] },
        fecha: { gte: inicioMes },
      },
      select: { fecha: true, subtotal: true, descuento: true, total: true, origen: true },
    }),
    prisma.salPedido.count({
      where: { companyId, estado: { in: ["PAGADO", "PENDIENTE_PAGO"] }, surtidoAt: null },
    }),
    prisma.salPedido.count({
      where: { companyId, estado: "SURTIDO", recogeEnTienda: false },
    }),
    prisma.salListaPrecio.findFirst({
      where: { companyId, publica: true, activa: true },
      select: { id: true },
    }),
  ]);

  // ── 1. Caducidad ──────────────────────────────────────────────────────────
  const vencidos = lotes.filter((l) => l.caducidad && l.caducidad < ahora);
  const porVencer = lotes.filter(
    (l) => l.caducidad && l.caducidad >= ahora && l.caducidad <= corteCaducidad
  );
  const valorDe = (ls: typeof lotes) =>
    r2(ls.reduce((a, l) => a + Number(l.cantidad) * Number(l.costoUnitario), 0));

  // ── 2. Quiebre ────────────────────────────────────────────────────────────
  const conPrecio = listaPublica
    ? new Set(
        (
          await prisma.salPrecio.findMany({
            where: { listaId: listaPublica.id },
            select: { productoId: true },
          })
        ).map((p) => p.productoId)
      )
    : new Set<string>();

  // Un preventa se vende SIN stock a propósito: no cuenta como quiebre.
  const publicadosSinStock = productos.filter(
    (p) => p.publicado && !p.preventa && Number(p.stock) <= 0
  );
  const publicadosSinPrecio = productos.filter((p) => p.publicado && !conPrecio.has(p.id));
  const bajoMinimo = productos.filter(
    (p) => Number(p.stockMinimo) > 0 && Number(p.stock) <= Number(p.stockMinimo)
  );

  // ── 3. Contenedores ───────────────────────────────────────────────────────
  const enTransito = importaciones.map((imp) => {
    const tc = Number(imp.tipoCambio);
    const mercancia = imp.items.reduce(
      (a, i) => a + Number(i.cantidad) * Number(i.precioMoneda) * tc,
      0
    );
    const costos = imp.costos
      .filter((c) => c.prorratea)
      .reduce((a, c) => a + Number(c.importe), 0);
    return {
      id: imp.id,
      folio: imp.folio,
      estado: imp.estado,
      fechaLlegada: imp.fechaLlegada,
      invertido: r2(mercancia + costos),
      diasParaLlegar:
        imp.fechaLlegada == null
          ? null
          : Math.ceil((imp.fechaLlegada.getTime() - ahora.getTime()) / 86_400_000),
    };
  });

  // ── 4. Ventas ─────────────────────────────────────────────────────────────
  const ventasMes = r2(
    pedidosMes.reduce((a, p) => a + Number(p.subtotal) - Number(p.descuento), 0)
  );
  const ventasHoy = r2(
    pedidosMes
      .filter((p) => p.fecha >= inicioDia)
      .reduce((a, p) => a + Number(p.subtotal) - Number(p.descuento), 0)
  );
  const enLinea = pedidosMes.filter((p) => p.origen === "TIENDA").length;

  return NextResponse.json({
    ventas: {
      hoy: ventasHoy,
      mes: ventasMes,
      pedidosMes: pedidosMes.length,
      pedidosEnLinea: enLinea,
      ticketPromedio: pedidosMes.length ? r2(ventasMes / pedidosMes.length) : 0,
    },
    almacen: {
      valor: valorDe(lotes),
      lotes: lotes.length,
      diasAlerta,
      vencido: { lotes: vencidos.length, valor: valorDe(vencidos) },
      porVencer: {
        lotes: porVencer.length,
        valor: valorDe(porVencer),
        // Los cinco que más urgen, para que la alerta sea accionable y no un número.
        top: porVencer
          .sort((a, b) => (a.caducidad!.getTime() - b.caducidad!.getTime()))
          .slice(0, 5)
          .map((l) => ({
            productoId: l.producto.id,
            sku: l.producto.sku,
            nombre: l.producto.nombre,
            caducidad: l.caducidad,
            valor: r2(Number(l.cantidad) * Number(l.costoUnitario)),
          })),
      },
    },
    quiebre: {
      publicadosSinStock: publicadosSinStock.map((p) => ({
        id: p.id,
        sku: p.sku,
        nombre: p.nombre,
      })),
      publicadosSinPrecio: publicadosSinPrecio.map((p) => ({
        id: p.id,
        sku: p.sku,
        nombre: p.nombre,
      })),
      bajoMinimo: bajoMinimo.map((p) => ({
        id: p.id,
        sku: p.sku,
        nombre: p.nombre,
        stock: Number(p.stock),
        stockMinimo: Number(p.stockMinimo),
      })),
    },
    importaciones: {
      enTransito,
      invertido: r2(enTransito.reduce((a, i) => a + i.invertido, 0)),
    },
    pendientes: { porSurtir, porEnviar },
  });
});
