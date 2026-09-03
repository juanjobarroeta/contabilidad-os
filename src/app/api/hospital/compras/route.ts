/**
 * GET /api/hospital/compras?companyId=…&anio=2026&mes=8[&q=…]
 *
 * Compras del mes: los CFDIs EGRESO recibidos con sus conceptos, lo pagado
 * (misma evidencia que la cartera: PUE pagada al emitirse, PPD por
 * conciliación o REP) y el resumen por proveedor. Las notas de crédito
 * (tipoSat "E") van aparte en `notasCredito`. Cada concepto trae `insumoId`
 * cuando clasifica como insumo y ya existe en el catálogo de farmacia — es lo
 * que liga la línea de la factura con la recepción del lote. Sólo lectura;
 * la lista se topa a 200 facturas (las más recientes) y los totales cubren el
 * mes completo.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import {
  amparadoDe,
  amparadoPorReps,
  conciliadoDe,
  pagadoPorEvidencia,
  r2,
} from "@/lib/hospital/cobranza";
import { claveDeInsumo, clasificarInsumo, normalizarDescripcion } from "@/lib/hospital/insumos-cfdi";

const TOPE_FACTURAS = 200;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const hoy = new Date();
  const anio = Number(searchParams.get("anio") ?? hoy.getFullYear());
  const mes = Number(searchParams.get("mes") ?? hoy.getMonth() + 1);
  if (!Number.isInteger(anio) || !Number.isInteger(mes) || mes < 1 || mes > 12 || anio < 2000 || anio > 2100) {
    return NextResponse.json({ error: "Periodo inválido" }, { status: 400 });
  }
  const q = (searchParams.get("q") ?? "").trim();
  const desde = new Date(anio, mes - 1, 1);
  const hasta = new Date(anio, mes, 1);

  const cfdis = (
    await prisma.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: { not: "CANCELLED" }, fecha: { gte: desde, lt: hasta } },
      select: {
        id: true,
        uuid: true,
        serie: true,
        folio: true,
        fecha: true,
        total: true,
        subtotal: true,
        metodoPago: true,
        tipoSat: true,
        customerId: true,
        contraparteNombre: true,
        contraparteRfc: true,
        customer: { select: { razonSocial: true, rfc: true } },
        conciliacionDetalles: { select: { montoAsignado: true } },
        items: {
          select: {
            descripcion: true,
            cantidad: true,
            claveUnidad: true,
            claveProdServ: true,
            valorUnitario: true,
            importe: true,
          },
        },
      },
      orderBy: { fecha: "desc" },
    })
  ).map((f) => ({ ...f, total: Number(f.total), subtotal: Number(f.subtotal) }));

  // Búsqueda: proveedor, folio fiscal/serie-folio o texto de algún concepto.
  const filtro = q.toLowerCase();
  const coincide = (f: (typeof cfdis)[number]) =>
    !filtro ||
    [f.customer?.razonSocial, f.customer?.rfc, f.contraparteNombre, f.contraparteRfc, f.uuid, f.serie, f.folio]
      .some((s) => s?.toLowerCase().includes(filtro)) ||
    f.items.some((it) => it.descripcion.toLowerCase().includes(filtro));
  const visibles = cfdis.filter(coincide);

  const facturasDb = visibles.filter((f) => (f.tipoSat ?? "I") !== "E");
  const notasDb = visibles.filter((f) => (f.tipoSat ?? "I") === "E");

  // Ligar conceptos con el catálogo de farmacia: por la llave de descripción y,
  // para los insumos cuya clave nació del NoIdentificacion del XML (que
  // InvoiceItem no guarda), por los movimientos que ese mismo CFDI derivó.
  const clavesDesc = new Set<string>();
  for (const f of facturasDb) {
    for (const it of f.items) {
      if (!clasificarInsumo(it).esInsumo) continue;
      const k = claveDeInsumo(null, it.descripcion);
      if (k) clavesDesc.add(k);
    }
  }
  const [amparado, insumosPorClave, derivados] = await Promise.all([
    amparadoPorReps(prisma, facturasDb.map((f) => f.uuid)),
    clavesDesc.size
      ? prisma.hospInsumo.findMany({
          where: { companyId, clave: { in: [...clavesDesc] } },
          select: { id: true, clave: true },
        })
      : Promise.resolve([] as Array<{ id: string; clave: string }>),
    facturasDb.length
      ? prisma.hospMovimientoInsumo.findMany({
          where: { companyId, tipo: "ENTRADA_COMPRA", invoiceId: { in: facturasDb.slice(0, TOPE_FACTURAS).map((f) => f.id) } },
          select: { invoiceId: true, insumoId: true, insumo: { select: { nombre: true } } },
        })
      : Promise.resolve([] as Array<{ invoiceId: string | null; insumoId: string; insumo: { nombre: string } }>),
  ]);
  const insumoPorClave = new Map(insumosPorClave.map((i) => [i.clave, i.id]));
  const derivadosPorFactura = new Map<string, Array<{ insumoId: string; nombreNorm: string }>>();
  for (const d of derivados) {
    if (!d.invoiceId) continue;
    const lista = derivadosPorFactura.get(d.invoiceId) ?? [];
    lista.push({ insumoId: d.insumoId, nombreNorm: normalizarDescripcion(d.insumo.nombre) });
    derivadosPorFactura.set(d.invoiceId, lista);
  }

  type Proveedor = { customerId: string | null; razonSocial: string; rfc: string | null; facturas: number; importe: number; pagado: number; pendiente: number };
  const porProveedor = new Map<string, Proveedor>();
  const totales = { facturas: 0, importe: 0, pagado: 0, pendiente: 0, notasCredito: 0 };

  const facturas = facturasDb.map((f) => {
    const ev = pagadoPorEvidencia({
      metodoPago: f.metodoPago,
      total: f.total,
      conciliado: conciliadoDe(f.conciliacionDetalles),
      amparadoRep: amparadoDe(amparado, f.uuid),
    });
    const razonSocial = f.customer?.razonSocial ?? f.contraparteNombre ?? "—";
    const rfc = f.customer?.rfc ?? f.contraparteRfc ?? null;
    const kProv = f.customerId ?? `rfc:${rfc ?? razonSocial}`;
    const prov = porProveedor.get(kProv) ?? { customerId: f.customerId, razonSocial, rfc, facturas: 0, importe: 0, pagado: 0, pendiente: 0 };
    prov.facturas += 1;
    prov.importe = r2(prov.importe + f.total);
    prov.pagado = r2(prov.pagado + ev.pagado);
    prov.pendiente = r2(prov.pendiente + ev.saldo);
    porProveedor.set(kProv, prov);
    totales.facturas += 1;
    totales.importe = r2(totales.importe + f.total);
    totales.pagado = r2(totales.pagado + ev.pagado);
    totales.pendiente = r2(totales.pendiente + ev.saldo);

    const derivadosDeEsta = derivadosPorFactura.get(f.id) ?? [];
    return {
      id: f.id,
      uuid: f.uuid,
      serie: f.serie,
      folio: f.folio,
      fecha: f.fecha,
      proveedor: { customerId: f.customerId, razonSocial, rfc },
      subtotal: f.subtotal,
      total: f.total,
      metodoPago: f.metodoPago,
      pagado: ev.pagado,
      saldo: ev.saldo,
      repPendiente: ev.repPendiente,
      items: f.items.map((it) => {
        const clasif = clasificarInsumo(it);
        let insumoId: string | null = null;
        if (clasif.esInsumo) {
          const kDesc = claveDeInsumo(null, it.descripcion);
          insumoId =
            (kDesc && insumoPorClave.get(kDesc)) ||
            derivadosDeEsta.find((d) => d.nombreNorm === normalizarDescripcion(it.descripcion))?.insumoId ||
            (derivadosDeEsta.length === 1 && f.items.filter((x) => clasificarInsumo(x).esInsumo).length === 1
              ? derivadosDeEsta[0].insumoId
              : null);
        }
        return {
          descripcion: it.descripcion,
          cantidad: Number(it.cantidad),
          claveUnidad: it.claveUnidad,
          claveProdServ: it.claveProdServ,
          valorUnitario: Number(it.valorUnitario),
          importe: Number(it.importe),
          esInsumo: clasif.esInsumo,
          categoria: clasif.esInsumo ? clasif.categoria : null,
          insumoId,
        };
      }),
    };
  });

  const notasCredito = notasDb.map((n) => {
    totales.notasCredito = r2(totales.notasCredito + n.total);
    return {
      id: n.id,
      uuid: n.uuid,
      serie: n.serie,
      folio: n.folio,
      fecha: n.fecha,
      proveedor: {
        customerId: n.customerId,
        razonSocial: n.customer?.razonSocial ?? n.contraparteNombre ?? "—",
        rfc: n.customer?.rfc ?? n.contraparteRfc ?? null,
      },
      total: n.total,
    };
  });

  return NextResponse.json({
    periodo: { anio, mes },
    q: q || null,
    totales,
    porProveedor: [...porProveedor.values()].sort((a, b) => b.importe - a.importe),
    facturas: facturas.slice(0, TOPE_FACTURAS),
    truncado: facturas.length > TOPE_FACTURAS,
    notasCredito,
  });
});
