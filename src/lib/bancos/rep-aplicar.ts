// ─────────────────────────────────────────────────────────────────────────────
// Aplica la conciliación por REP sobre los movimientos pendientes.
//
// La decisión vive en `rep-conciliar.ts` (pura y probada); aquí sólo se buscan
// los candidatos y se escriben las porciones. Se guarda SIEMPRE por porciones
// (ConciliacionDetalle), incluso cuando el REP liquida una sola factura: el
// importe por factura es el dato que necesita `reclasificacionIvaFlujo` para
// mover el IVA correcto de pendiente a pagado. Con el vínculo 1:1 se perdería
// justo eso.
// ─────────────────────────────────────────────────────────────────────────────
import { prisma } from "@/lib/prisma";
import { checkInvoiceMatchGuard, mergePagosConciliados } from "@/lib/conciliacion";
import { agruparPagos, elegirPagoRep, VENTANA_DIAS, type PagoRep } from "./rep-conciliar";

export interface ResultadoRep {
  companyId: string;
  /** Movimientos que se revisaron. */
  revisados: number;
  conciliados: number;
  /** Facturas liquidadas por esas conciliaciones. */
  facturasAplicadas: number;
  ambiguos: number;
  /** El REP nombra facturas que no tenemos sincronizadas. */
  incompletos: number;
  sinRep: number;
  /** Un guard rechazó la porción (saldo insuficiente, PUE ya pagada…). */
  rechazados: number;
  detalle: Array<{ fecha: string; monto: number; contraparte: string; facturas: number }>;
  avisos: string[];
}

export async function conciliarPorRepEmpresa(
  companyId: string,
  opts: { max?: number; aplicar?: boolean; ventanaDias?: number } = {},
): Promise<ResultadoRep> {
  const max = opts.max ?? 500;
  const aplicar = opts.aplicar ?? true;
  const ventanaDias = opts.ventanaDias ?? VENTANA_DIAS;
  const out: ResultadoRep = {
    companyId, revisados: 0, conciliados: 0, facturasAplicadas: 0,
    ambiguos: 0, incompletos: 0, sinRep: 0, rechazados: 0, detalle: [], avisos: [],
  };

  const pendientes = (
    await prisma.bankTransaction.findMany({
      where: { companyId, status: "UNMATCHED" },
      select: { id: true, fecha: true, monto: true, contraparteRfc: true, contraparteNombre: true, descripcion: true },
      orderBy: { fecha: "asc" },
      take: max,
    })
  ).map((t) => ({ ...t, monto: Number(t.monto) }));
  out.revisados = pendientes.length;
  if (pendientes.length === 0) return out;

  for (const tx of pendientes) {
    const desde = new Date(tx.fecha.getTime() - ventanaDias * 86_400_000);
    const hasta = new Date(tx.fecha.getTime() + ventanaDias * 86_400_000);

    // Candidatos: REP cuya FECHA DE PAGO cae en la ventana. Se filtra por el
    // docto y no por la fecha del comprobante — el REP se emite hasta el día 5
    // del mes siguiente, así que filtrar por emisión dejaría fuera los del
    // cierre de mes, que son la mayoría.
    const reps = await prisma.invoice.findMany({
      where: {
        companyId,
        tipo: "PAGO",
        status: { not: "CANCELLED" },
        doctosRelacionados: { some: { fechaPago: { gte: desde, lte: hasta } } },
        ...(tx.contraparteRfc
          ? {
              OR: [
                { contraparteRfc: { equals: tx.contraparteRfc, mode: "insensitive" } },
                { customer: { rfc: { equals: tx.contraparteRfc, mode: "insensitive" } } },
              ],
            }
          : {}),
      },
      select: {
        id: true, fecha: true, contraparteRfc: true,
        customer: { select: { rfc: true } },
        doctosRelacionados: { select: { parentUuid: true, impPagado: true, fechaPago: true } },
      },
      take: 200,
    });
    if (reps.length === 0) { out.sinRep++; continue; }

    // Resolver las facturas padre por UUID (y su tipo, que fija el sentido).
    const uuids = [...new Set(reps.flatMap((r) => r.doctosRelacionados.map((d) => d.parentUuid)))];
    const padres = await prisma.invoice.findMany({
      where: { companyId, uuid: { in: uuids } },
      select: { id: true, uuid: true, tipo: true },
    });
    const padrePorUuid = new Map(padres.map((p) => [p.uuid ?? "", p]));

    const pagos: PagoRep[] = reps.flatMap((r) =>
      agruparPagos(
        { id: r.id, fecha: r.fecha, rfcContraparte: r.customer?.rfc ?? r.contraparteRfc ?? null },
        r.doctosRelacionados.map((d) => {
          const padre = padrePorUuid.get(d.parentUuid);
          return {
            uuid: d.parentUuid,
            impPagado: Number(d.impPagado ?? 0),
            fechaPago: d.fechaPago,
            invoiceId: padre?.id ?? null,
            tipoPadre: padre?.tipo ?? null,
          };
        }),
      ),
    );

    const eleccion = elegirPagoRep(tx, pagos, { ventanaDias });
    if (eleccion.estado === "sin_candidato") { out.sinRep++; continue; }
    if (eleccion.estado === "ambiguo") {
      out.ambiguos++;
      out.avisos.push(
        `${tx.fecha.toISOString().slice(0, 10)} ${tx.monto.toFixed(2)}: ${eleccion.pagos.length} REP empatan; no se aplica.`,
      );
      continue;
    }
    if (eleccion.estado === "incompleto") {
      out.incompletos++;
      out.avisos.push(
        `${tx.fecha.toISOString().slice(0, 10)} ${tx.monto.toFixed(2)}: el REP nombra ${eleccion.faltantes.length} CFDI que no tenemos.`,
      );
      continue;
    }

    // ── Guards por factura, los MISMOS del PATCH ──────────────────────────
    // El REP es autoridad sobre lo que el proveedor declaró, no sobre lo que
    // ya registramos: si esa factura ya tiene pagos aplicados aquí, sumar el
    // desglose la sobregiraría. Todo o nada.
    const asignaciones = eleccion.pago.docs.map((d) => ({
      invoiceId: d.invoiceId as string,
      monto: Math.round(d.impPagado * 100) / 100,
    }));
    const facturas = await prisma.invoice.findMany({
      where: { id: { in: asignaciones.map((a) => a.invoiceId) }, companyId },
      select: {
        id: true, total: true, metodoPago: true, status: true,
        bankTransactions: { where: { status: "MATCHED" }, select: { id: true, fecha: true, monto: true } },
        conciliacionDetalles: {
          select: {
            bankTransactionId: true, montoAsignado: true,
            bankTransaction: { select: { fecha: true, monto: true } },
          },
        },
      },
    });
    const porId = new Map(facturas.map((f) => [f.id, f]));
    let rechazo: string | null = null;
    for (const a of asignaciones) {
      const f = porId.get(a.invoiceId);
      if (!f) { rechazo = "una factura del REP no existe en la empresa"; break; }
      if (f.status !== "STAMPED") { rechazo = "una factura del REP no está timbrada"; break; }
      const guard = checkInvoiceMatchGuard(
        { metodoPago: f.metodoPago ?? "", total: Number(f.total) },
        mergePagosConciliados(
          f.bankTransactions.map((t) => ({ ...t, monto: Number(t.monto) })),
          f.conciliacionDetalles.map((d) => ({
            ...d,
            montoAsignado: Number(d.montoAsignado),
            bankTransaction: { ...d.bankTransaction, monto: Number(d.bankTransaction.monto) },
          })),
        ),
        { id: tx.id, monto: tx.monto, montoAsignado: a.monto },
      );
      if (!guard.ok) { rechazo = guard.error; break; }
    }
    if (rechazo) {
      out.rechazados++;
      out.avisos.push(`${tx.fecha.toISOString().slice(0, 10)} ${tx.monto.toFixed(2)}: ${rechazo}`);
      continue;
    }

    out.conciliados++;
    out.facturasAplicadas += asignaciones.length;
    out.detalle.push({
      fecha: tx.fecha.toISOString().slice(0, 10),
      monto: tx.monto,
      contraparte: tx.contraparteNombre ?? tx.descripcion.slice(0, 40),
      facturas: asignaciones.length,
    });
    if (!aplicar) continue;

    // Todo-o-nada, igual que el PATCH: porciones + MATCHED con invoiceId en
    // NULL (el vínculo legado no puede representar varias facturas).
    await prisma.$transaction([
      prisma.conciliacionDetalle.createMany({
        data: asignaciones.map((a) => ({
          bankTransactionId: tx.id, invoiceId: a.invoiceId, montoAsignado: a.monto,
        })),
        skipDuplicates: true,
      }),
      prisma.bankTransaction.update({
        where: { id: tx.id },
        data: { status: "MATCHED", invoiceId: null },
      }),
    ]);
  }

  return out;
}
