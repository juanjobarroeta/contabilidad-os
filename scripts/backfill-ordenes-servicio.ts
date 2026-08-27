/**
 * Puebla OrdenServicio + OrdenServicioLinea desde lo que ya derivamos del CFDI.
 *
 * El taller NO se opera en ContabilidadOS, así que OrdenServicio está vacío —
 * pero de los CFDIs ya salió `ServicioVenta` (la venta facturada: fecha, total,
 * mano de obra vs refacciones, concepto, cliente, unidad) y `RefaccionMovimiento`
 * (las partes que salieron con cada factura). Con eso se reconstruye la HISTORIA
 * del taller como órdenes de servicio, para que la pantalla tenga con qué vivir.
 *
 * Qué se puebla y qué no:
 *   • estado = ENTREGADA — están facturadas, o sea entregadas.
 *   • folio, cliente, unidad, fecha, y el `concepto` como falla reportada
 *     (es la única descripción libre que trae el CFDI; el campo es obligatorio).
 *   • líneas: MANO_OBRA (del monto de mano de obra) + una REFACCION por cada
 *     movimiento de almacén de esa factura, con su parte y precio.
 *   • NO se inventan diagnóstico, técnico, asesor, kilometraje ni placas — eso
 *     vive en el DMS, no en el CFDI. Quedan en null; las órdenes NUEVAS que se
 *     capturen en la app sí los traerán.
 *
 * Idempotente: salta la ServicioVenta que ya tiene su orden (por servicioVentaId).
 *
 * Uso (dry-run por default):
 *   DATABASE_URL=<url> RFC=<rfc>|COMPANY_ID=<id> [APPLY=1] \
 *   ts-node --compiler-options '{"module":"CommonJS"}' scripts/backfill-ordenes-servicio.ts
 */
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { resolverEmpresa } from "./lib/empresa";

const APPLY = process.env.APPLY === "1";
const LOTE = 2000; // lotes grandes: la inserción es masiva, no fila por fila

async function main() {
  const prisma = new PrismaClient();
  try {
    const empresa = await resolverEmpresa(prisma);
    const COMPANY = empresa.id;
    console.log(`Empresa: ${empresa.razonSocial ?? empresa.rfc} (${COMPANY})`);

    // RESET borra las órdenes YA derivadas (las ligadas a ServicioVenta) para
    // re-derivarlas limpias — necesario cuando cambia la lógica de líneas. No
    // toca órdenes capturadas a mano (sin servicioVentaId).
    if (process.env.RESET === "1" && APPLY) {
      const del = await prisma.ordenServicio.deleteMany({ where: { companyId: COMPANY, servicioVentaId: { not: null } } });
      console.log(`RESET: ${del.count.toLocaleString()} órdenes derivadas borradas (las líneas caen en cascada)`);
    }

    // ServicioVenta sin orden todavía (idempotencia por servicioVentaId).
    const yaConOrden = new Set(
      (await prisma.ordenServicio.findMany({
        where: { companyId: COMPANY, servicioVentaId: { not: null } },
        select: { servicioVentaId: true },
      })).map((o) => o.servicioVentaId!),
    );
    const ventas = await prisma.servicioVenta.findMany({
      where: { companyId: COMPANY },
      select: {
        id: true, invoiceId: true, clienteId: true, vehiculoId: true,
        fecha: true, manoObra: true, refacciones: true, concepto: true,
      },
      orderBy: { fecha: "asc" },
    });
    const pendientes = ventas.filter((v) => !yaConOrden.has(v.id));
    console.log(`${ventas.length.toLocaleString()} ServicioVenta · ${pendientes.length.toLocaleString()} sin orden`);
    if (pendientes.length === 0) return;

    // Datos de la unidad (vin, descripción) para las órdenes que la traen.
    const vehIds = [...new Set(pendientes.map((v) => v.vehiculoId).filter(Boolean) as string[])];
    const vehs = new Map(
      (await prisma.vehiculo.findMany({
        where: { id: { in: vehIds } },
        select: { id: true, vin: true, marca: true, modelo: true, anio: true },
      })).map((v) => [v.id, v]),
    );

    // Partes por factura (las líneas REFACCION), de una sola consulta.
    const invIds = [...new Set(pendientes.map((v) => v.invoiceId).filter(Boolean) as string[])];
    const partesPorInvoice = new Map<string, { refaccionId: string; descripcion: string; cantidad: number; precio: number }[]>();
    for (let i = 0; i < invIds.length; i += 1000) {
      const movs = await prisma.refaccionMovimiento.findMany({
        where: { invoiceId: { in: invIds.slice(i, i + 1000) }, tipo: "SALIDA_VENTA" },
        select: { invoiceId: true, cantidad: true, montoUnitario: true, refaccion: { select: { id: true, descripcion: true } } },
      });
      for (const m of movs) {
        if (!m.invoiceId) continue;
        const arr = partesPorInvoice.get(m.invoiceId) ?? [];
        arr.push({
          refaccionId: m.refaccion.id,
          descripcion: m.refaccion.descripcion ?? "Refacción",
          cantidad: Math.abs(Number(m.cantidad ?? 1)),
          precio: Math.abs(Number(m.montoUnitario ?? 0)),
        });
        partesPorInvoice.set(m.invoiceId, arr);
      }
    }

    // Folio consecutivo desde el máximo actual de la empresa.
    const maxFolio = (await prisma.ordenServicio.aggregate({
      where: { companyId: COMPANY }, _max: { folio: true },
    }))._max.folio ?? 0;
    let folio = maxFolio;

    // Inserción MASIVA, no fila por fila. El id se genera aquí (el PK es un
    // String; la orden y sus líneas se ligan sin ir a la base por cada `create`).
    // Así cada lote son ~2 round-trips (una orden, una línea) en vez de ~1000 —
    // lo que hacía lenta la corrida sobre el proxy. En Railway (DB local) vuela.
    let ordenes = 0, lineas = 0;
    for (let i = 0; i < pendientes.length; i += LOTE) {
      const lote = pendientes.slice(i, i + LOTE);
      const filasOrden: any[] = [];
      const filasLinea: any[] = [];
      for (const v of lote) {
        const veh = v.vehiculoId ? vehs.get(v.vehiculoId) : null;
        const partes = v.invoiceId ? (partesPorInvoice.get(v.invoiceId) ?? []) : [];
        folio += 1;
        const ordenId = randomUUID();
        filasOrden.push({
          id: ordenId, companyId: COMPANY, folio, estado: "ENTREGADA",
          clienteId: v.clienteId, vehiculoId: v.vehiculoId, vin: veh?.vin ?? null,
          descripcionUnidad: veh ? `${veh.marca ?? ""} ${veh.modelo ?? ""} ${veh.anio ?? ""}`.trim() || null : null,
          fallaReportada: (v.concepto ?? "Servicio de taller").slice(0, 2000),
          recibidaAt: v.fecha, entregadaAt: v.fecha, servicioVentaId: v.id,
        });
        ordenes++;
        if (Number(v.manoObra) > 0.005)
          filasLinea.push({ ordenId, tipo: "MANO_OBRA", descripcion: (v.concepto ?? "Mano de obra").slice(0, 500), cantidad: 1, precioUnitario: v.manoObra });
        for (const pt of partes)
          filasLinea.push({ ordenId, tipo: "REFACCION", descripcion: pt.descripcion.slice(0, 500), cantidad: pt.cantidad, precioUnitario: pt.precio, refaccionId: pt.refaccionId });
        // Residuo: refacciones facturadas − itemizadas del kardex, como una
        // línea resumen, para que la orden sume lo que de verdad se cobró.
        const itemizado = partes.reduce((a, pt) => a + pt.cantidad * pt.precio, 0);
        const residuo = Math.round((Number(v.refacciones) - itemizado) * 100) / 100;
        if (residuo > 0.005)
          filasLinea.push({ ordenId, tipo: "REFACCION", descripcion: "Refacciones (sin desglose en kardex)", cantidad: 1, precioUnitario: residuo });
      }
      lineas += filasLinea.length;
      if (!APPLY) continue;
      // El lote entero en UNA transacción: órdenes y sus líneas caen juntas o no
      // caen. Si se interrumpe entre las dos, la idempotencia (por
      // servicioVentaId) saltaría órdenes sin líneas — el tx lo evita.
      await prisma.$transaction(async (tx) => {
        await tx.ordenServicio.createMany({ data: filasOrden });
        for (let j = 0; j < filasLinea.length; j += 5000)
          await tx.ordenServicioLinea.createMany({ data: filasLinea.slice(j, j + 5000) });
      }, { timeout: 120000 });
      console.log(`  ${Math.min(i + LOTE, pendientes.length).toLocaleString()}/${pendientes.length.toLocaleString()}…`);
    }
    console.log(`\n${APPLY ? "" : "[dry-run] "}${ordenes.toLocaleString()} órdenes · ${lineas.toLocaleString()} líneas`);
    if (!APPLY) console.log("APPLY=1 para escribir.");
  } finally {
    await prisma.$disconnect();
  }
}

main();
