/**
 * Reconstruye los ciclos dañados de MARGOM re-derivando la historia de cada VIN
 * en ORDEN CRONOLÓGICO desde sus CFDIs, con el derivador de PRODUCCIÓN
 * (derivarVehiculoDesdeCfdiSiAplica, ya con idempotencia a través de ciclos).
 *
 * El daño (medido 2026-08-16): la repesca reprocesó CFDIs viejos en cualquier
 * orden y el derivador comparaba sólo contra el ciclo vigente — 153 VINs con
 * ventas anteriores a su compra, la misma venta en dos ciclos o la misma compra
 * en dos, y $7.5M de piso fantasma al corte 2026-06.
 *
 * DRY-RUN (default): re-deriva contra una base EN MEMORIA y muestra el antes →
 * después por VIN. No escribe nada. Aplicar: APPLY=1.
 *
 * Conservador:
 *   • Un VIN se SALTA (y se reporta) si algo suyo tiene datos que la re-derivación
 *     no puede reconstruir: renglones editados a mano (autoCreado=false), costos
 *     manuales, referencias de pedidos/servicio/prospectos, o un renglón espurio
 *     con campos capturados a mano (vendedor, comisión, ISAN…).
 *   • Los campos NO derivables de renglones que sobreviven (número económico,
 *     kilometraje, precio lista, notas…) se copian al renglón reconstruido que
 *     comparte su factura de compra o de venta.
 *   • APPLY corre en una transacción POR VIN: borra los renglones del VIN
 *     (cascada: costos y menciones) y re-deriva contra la base real.
 *
 * Uso:
 *   DATABASE_URL=<url> DRY_RUN=1 TS_NODE_BASEURL=. \
 *   npx ts-node -r tsconfig-paths/register --compiler-options '{"module":"CommonJS"}' \
 *     scripts/reconstruir-ciclos-margom.ts
 */
import { PrismaClient } from "@prisma/client";
import {
  derivarVehiculoDesdeCfdiSiAplica,
  resolverSupplierDesdeEmisor,
} from "../src/lib/automotriz/auto-vehiculo";

const APPLY = process.env.APPLY === "1";
const COMPANY = "cmsjf1wna003kn70fb68bqhm4"; // MARGOM

/** Campos que el derivador NO reconstruye y hay que acarrear del renglón viejo.
 *  Un valor igual al DEFAULT del schema (uso=VENTA, isan=0, comisionMonto=0)
 *  no es dato capturado: no bloquea ni se acarrea. */
const CAMPOS_MANUALES = [
  "numeroEconomico", "color", "kilometraje", "precioLista", "isan",
  "comisionMonto", "vendedorId", "notas", "uso", "planPisoTasaAnual", "planPisoInicio",
] as const;

const DEFAULTS: Partial<Record<(typeof CAMPOS_MANUALES)[number], unknown>> = {
  uso: "VENTA",
  isan: 0,
  comisionMonto: 0,
};

const esDatoManual = (campo: (typeof CAMPOS_MANUALES)[number], valor: unknown) =>
  valor != null && valor !== DEFAULTS[campo];

type FilaVehiculo = Record<string, unknown> & { id: string };

/** Base EN MEMORIA con la superficie que usa el derivador. Lecturas de
 *  catálogo/facturas pasan a la base real (son de sólo lectura). */
function memDb(prisma: PrismaClient) {
  const vehiculos = new Map<string, FilaVehiculo>();
  const costos: Record<string, unknown>[] = [];
  const menciones: Record<string, unknown>[] = [];
  let seq = 1;
  const clean = (d: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
  return {
    _vehiculos: vehiculos,
    vehiculo: {
      findFirst: async ({ where, select }: any) => {
        const hits = [...vehiculos.values()].filter(
          (v) =>
            v.companyId === where.companyId &&
            v.vin === where.vin &&
            (where.compraInvoiceId == null || v.compraInvoiceId === where.compraInvoiceId) &&
            (where.ventaInvoiceId == null || v.ventaInvoiceId === where.ventaInvoiceId),
        );
        if (hits.length === 0) return null;
        hits.sort((a, b) => ((b.ciclo as number) ?? 1) - ((a.ciclo as number) ?? 1));
        const row = { ...hits[0] };
        return select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row;
      },
      create: async ({ data }: any) => {
        const id = `sim_${seq++}`;
        const row = { id, ciclo: 1, ...clean(data) } as FilaVehiculo;
        vehiculos.set(id, row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = vehiculos.get(where.id)!;
        Object.assign(row, clean(data));
        return row;
      },
    },
    vehiculoCosto: {
      findFirst: async ({ where }: any) =>
        costos.find((c) => c.vehiculoId === where.vehiculoId && c.invoiceId === where.invoiceId) ?? null,
      createMany: async ({ data }: any) => (costos.push(...data.map((d: any) => ({ ...d }))), { count: data.length }),
      deleteMany: async ({ where }: any) => {
        let n = 0;
        for (let i = costos.length - 1; i >= 0; i--) {
          const c = costos[i];
          if (where.vehiculoId != null && c.vehiculoId !== where.vehiculoId) continue;
          if (where.invoiceId != null && c.invoiceId !== where.invoiceId) continue;
          if (where.autoCreado != null && (c.autoCreado ?? false) !== where.autoCreado) continue;
          costos.splice(i, 1);
          n++;
        }
        return { count: n };
      },
    },
    vehiculoCfdi: {
      upsert: async ({ where, create, update }: any) => {
        const f = menciones.find(
          (e) => e.vehiculoId === where.vehiculoId_invoiceId.vehiculoId && e.invoiceId === where.vehiculoId_invoiceId.invoiceId,
        );
        if (f) Object.assign(f, update);
        else menciones.push({ ...create });
        return f ?? create;
      },
    },
    // Los términos ya-existen: registrarTermsProveedor no crea nada en dry-run.
    supplierTerms: { findUnique: async () => ({ id: "simulado" }), create: async () => ({}) },
    invoice: { findUnique: (a: any) => prisma.invoice.findUnique(a) },
    claveVehicularCatalogo: { findUnique: (a: any) => prisma.claveVehicularCatalogo.findUnique(a) },
  };
}

interface EventoCfdi { id: string; fecha: Date; tipo: string; customerId: string | null }

async function main() {
  const prisma = new PrismaClient();
  try {
    // 1) VINs dañados (el censo del handoff).
    const dañados = await prisma.$queryRawUnsafe<{ vin: string }[]>(`
      SELECT vin FROM "Vehiculo"
      WHERE "companyId"='${COMPANY}' AND vin IS NOT NULL
      GROUP BY vin
      HAVING BOOL_OR("fechaVenta" < "fechaCompra")
          OR COUNT(DISTINCT "compraInvoiceId") FILTER (WHERE "compraInvoiceId" IS NOT NULL) < COUNT(*) FILTER (WHERE "compraInvoiceId" IS NOT NULL)
          OR COUNT(DISTINCT "ventaInvoiceId") FILTER (WHERE "ventaInvoiceId" IS NOT NULL) < COUNT(*) FILTER (WHERE "ventaInvoiceId" IS NOT NULL)
          OR COUNT(*) FILTER (WHERE "fechaVenta" IS NULL) > 1
      ORDER BY vin
    `);
    console.log(`${dañados.length} VINs dañados\n`);

    // 2) CFDIs por VIN (una sola pasada por lotes de alternación).
    const porVin = new Map<string, EventoCfdi[]>();
    const vins = dañados.map((d) => d.vin);
    for (let i = 0; i < vins.length; i += 40) {
      const lote = vins.slice(i, i + 40);
      const filas = await prisma.$queryRawUnsafe<(EventoCfdi & { vin: string })[]>(`
        SELECT i.id, i.fecha, i.tipo::text tipo, i."customerId", m.vin
        FROM "Invoice" i,
             LATERAL (SELECT DISTINCT (regexp_matches(i."rawXml", '(${lote.join("|")})', 'g'))[1] vin) m
        WHERE i."companyId"='${COMPANY}'
          AND i.tipo IN ('INGRESO','EGRESO')
          AND i.status NOT IN ('CANCELLED','DRAFT')
          AND i."rawXml" ~ '(${lote.join("|")})'
      `);
      for (const f of filas) {
        const l = porVin.get(f.vin) ?? [];
        l.push({ id: f.id, fecha: new Date(f.fecha), tipo: f.tipo, customerId: f.customerId });
        porVin.set(f.vin, l);
      }
    }

    let reconstruibles = 0;
    let saltados = 0;
    let aplicados = 0;
    let pisoAntes = 0;
    let pisoDespues = 0;

    for (const vin of vins) {
      const viejas = await prisma.vehiculo.findMany({
        where: { companyId: COMPANY, vin },
        orderBy: { ciclo: "asc" },
      });
      const idsViejos = viejas.map((v) => v.id);

      // Guardias: nada que la re-derivación no pueda reconstruir.
      const razones: string[] = [];
      if (viejas.some((v) => !v.autoCreado)) razones.push("renglón editado a mano");
      const costosManuales = await prisma.vehiculoCosto.count({
        where: { vehiculoId: { in: idsViejos }, autoCreado: false },
      });
      if (costosManuales > 0) razones.push(`${costosManuales} costos manuales`);
      const [pedidos, servicios, ordenes, prospectos] = await Promise.all([
        prisma.pedidoVehiculo.count({ where: { vehiculoId: { in: idsViejos } } }),
        prisma.servicioVenta.count({ where: { vehiculoId: { in: idsViejos } } }),
        prisma.ordenServicio.count({ where: { vehiculoId: { in: idsViejos } } }),
        prisma.prospecto.count({ where: { vehiculoId: { in: idsViejos } } }),
      ]);
      if (pedidos) razones.push(`${pedidos} pedidos`);
      if (servicios) razones.push(`${servicios} servicio-venta`);
      if (ordenes) razones.push(`${ordenes} órdenes de servicio`);
      if (prospectos) razones.push(`${prospectos} prospectos`);

      const eventos = (porVin.get(vin) ?? []).sort(
        (a, b) =>
          a.fecha.getTime() - b.fecha.getTime() ||
          (a.tipo === "EGRESO" ? -1 : 1) - (b.tipo === "EGRESO" ? -1 : 1) ||
          a.id.localeCompare(b.id),
      );
      if (eventos.length === 0) razones.push("sin CFDIs re-derivables");

      // 3) Simulación SIEMPRE (el dry-run del VIN), contra memoria.
      const sim = memDb(prisma);
      const supplierPorInvoice = new Map(
        viejas.filter((v) => v.compraInvoiceId && v.supplierId).map((v) => [v.compraInvoiceId!, v.supplierId!]),
      );
      for (const e of eventos) {
        const inv = await prisma.invoice.findUnique({ where: { id: e.id }, select: { rawXml: true } });
        if (!inv?.rawXml) continue;
        await derivarVehiculoDesdeCfdiSiAplica(sim as never, {
          companyId: COMPANY,
          invoiceId: e.id,
          tipo: e.tipo,
          fecha: e.fecha,
          rawXml: inv.rawXml,
          clienteId: e.tipo === "INGRESO" ? e.customerId : null,
          supplierId: supplierPorInvoice.get(e.id) ?? undefined,
        });
      }
      const nuevas = [...sim._vehiculos.values()]
        .filter((v) => v.vin === vin)
        .sort((a, b) => ((a.ciclo as number) ?? 1) - ((b.ciclo as number) ?? 1));

      // Renglón espurio (sin gemelo reconstruido por factura) con datos manuales.
      const gemelo = (v: (typeof viejas)[number]) =>
        nuevas.find(
          (n) =>
            (v.compraInvoiceId && n.compraInvoiceId === v.compraInvoiceId) ||
            (v.ventaInvoiceId && n.ventaInvoiceId === v.ventaInvoiceId),
        );
      for (const v of viejas) {
        if (!gemelo(v) && CAMPOS_MANUALES.some((c) => esDatoManual(c, (v as Record<string, unknown>)[c]))) {
          razones.push(`ciclo ${v.ciclo} espurio trae datos manuales`);
          break;
        }
      }

      const fmt = (r: Record<string, unknown>) =>
        `#${r.ciclo}:${String((r.fechaCompra as Date)?.toISOString?.()?.slice(0, 10) ?? "—")}→${
          String((r.fechaVenta as Date)?.toISOString?.()?.slice(0, 10) ?? "piso")
        }`;
      const antes = viejas.map(fmt).join(" ");
      const despues = nuevas.map(fmt).join(" ");
      const pisoV = viejas.filter((v) => v.fechaVenta == null).length;
      const pisoN = nuevas.filter((n) => n.fechaVenta == null).length;

      if (razones.length > 0) {
        saltados++;
        console.log(`SALTADO  ${vin}: ${razones.join("; ")}`);
        console.log(`         antes: ${antes}\n         sim:   ${despues}\n`);
        continue;
      }

      reconstruibles++;
      pisoAntes += pisoV;
      pisoDespues += pisoN;
      console.log(`${APPLY ? "APLICA " : "[dry]  "} ${vin}: ${viejas.length} → ${nuevas.length} ciclos, piso ${pisoV} → ${pisoN}`);
      console.log(`         antes: ${antes}\n         nuevo: ${despues}\n`);

      // 4) APPLY: transacción por VIN — borrar y re-derivar contra la base real.
      if (APPLY) {
        await prisma.$transaction(async (tx) => {
          await tx.vehiculo.deleteMany({ where: { companyId: COMPANY, vin } });
          for (const e of eventos) {
            const inv = await tx.invoice.findUnique({ where: { id: e.id }, select: { rawXml: true } });
            if (!inv?.rawXml) continue;
            await derivarVehiculoDesdeCfdiSiAplica(tx, {
              companyId: COMPANY,
              invoiceId: e.id,
              tipo: e.tipo,
              fecha: e.fecha,
              rawXml: inv.rawXml,
              clienteId: e.tipo === "INGRESO" ? e.customerId : null,
              supplierId: supplierPorInvoice.get(e.id) ?? undefined,
              resolverSupplierId: () => resolverSupplierDesdeEmisor(tx, COMPANY, inv.rawXml!),
            });
          }
          // Acarreo de campos manuales al renglón que comparte factura.
          const recreadas = await tx.vehiculo.findMany({ where: { companyId: COMPANY, vin } });
          for (const v of viejas) {
            const destino = recreadas.find(
              (n) =>
                (v.compraInvoiceId && n.compraInvoiceId === v.compraInvoiceId) ||
                (v.ventaInvoiceId && n.ventaInvoiceId === v.ventaInvoiceId),
            );
            if (!destino) continue;
            const data = Object.fromEntries(
              CAMPOS_MANUALES.map((c) => [c, (v as Record<string, unknown>)[c]]).filter(([c, x]) =>
                esDatoManual(c as (typeof CAMPOS_MANUALES)[number], x),
              ),
            );
            if (Object.keys(data).length > 0) {
              await tx.vehiculo.update({ where: { id: destino.id }, data });
            }
          }
        });
        aplicados++;
      }
    }

    console.log(
      `\n${APPLY ? "" : "[dry-run] "}listo: ${reconstruibles} reconstruibles` +
        `${APPLY ? ` (${aplicados} aplicados)` : ""}, ${saltados} saltados; ` +
        `piso de estos VINs: ${pisoAntes} → ${pisoDespues} renglones`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
