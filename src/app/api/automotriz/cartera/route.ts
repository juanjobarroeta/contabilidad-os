/**
 * GET /api/automotriz/cartera?companyId=…&lado=COBRAR|PAGAR
 *
 * Cartera agregada por contacto (vista Finanzas del plan §4.5):
 *   COBRAR → facturas INGRESO por cliente: facturado, cobrado (conciliación),
 *            saldo y monto PPD cobrado sin REP emitido (obligación nuestra).
 *   PAGAR  → facturas EGRESO por proveedor: pagado y pagos PPD sin REP
 *            recibido (riesgo de deducción, Art. 5-I LIVA).
 * Mismo empate por UUID normalizado que perfil-contacto. Sólo lectura; cada
 * fila drillea al perfil 360° del contacto.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, withAuthz } from "@/lib/authz";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";

const r2 = (n: number) => Math.round(n * 100) / 100;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const lado = searchParams.get("lado") === "PAGAR" ? "PAGAR" : "COBRAR";
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "AUTOMOTRIZ", req);

  const tipo = lado === "COBRAR" ? "INGRESO" : "EGRESO";
  const facturas = (
    await prisma.invoice.findMany({
      where: { companyId, tipo, status: { not: "CANCELLED" }, customerId: { not: null } },
      select: {
        customerId: true,
        uuid: true,
        total: true,
        metodoPago: true,
        fecha: true,
        customer: { select: { razonSocial: true, rfc: true } },
        conciliacionDetalles: { select: { montoAsignado: true } },
      },
    })
  ).map((f) => ({ ...f, total: Number(f.total) }));

  const uuids = facturas.map((f) => f.uuid).filter(Boolean) as string[];
  const links = uuids.length
    ? await prisma.pagoDoctoRelacionado.findMany({
        where: { parentUuid: { in: variantesUuid(uuids) } },
        select: { parentUuid: true, impPagado: true },
      })
    : [];
  const amparado = new Map<string, number>();
  for (const l of links) {
    const k = normalizarUuid(l.parentUuid);
    amparado.set(k, (amparado.get(k) ?? 0) + Number(l.impPagado ?? 0));
  }

  type Fila = {
    customerId: string; razonSocial: string; rfc: string;
    facturas: number; facturado: number; pagado: number; saldo: number;
    repPendiente: number; masAntigua: string | null;
  };
  const porContacto = new Map<string, Fila>();
  for (const f of facturas) {
    const fila = porContacto.get(f.customerId!) ?? {
      customerId: f.customerId!,
      razonSocial: f.customer?.razonSocial ?? "—",
      rfc: f.customer?.rfc ?? "—",
      facturas: 0, facturado: 0, pagado: 0, saldo: 0, repPendiente: 0, masAntigua: null,
    };
    const conciliado = f.conciliacionDetalles.reduce((s, d) => s + Math.abs(Number(d.montoAsignado)), 0);
    const rep = f.uuid ? (amparado.get(normalizarUuid(f.uuid)) ?? 0) : 0;
    // Evidencia de cobro/pago (misma regla que perfil-contacto): PUE queda
    // pagada en su emisión; PPD por la mejor evidencia (REP o banco). Así la
    // cartera es la real — sólo PPD sin amparar — aunque no haya bancos cargados.
    const pagado = f.metodoPago === "PPD" ? Math.max(conciliado, rep) : f.total;
    const saldoFactura = Math.max(0, f.total - pagado);
    fila.facturas += 1;
    fila.facturado += f.total;
    fila.pagado += pagado;
    fila.saldo += saldoFactura;
    if (f.metodoPago === "PPD") fila.repPendiente += Math.max(0, conciliado - rep);
    if (saldoFactura > 1 && (!fila.masAntigua || f.fecha.toISOString() < fila.masAntigua)) {
      fila.masAntigua = f.fecha.toISOString();
    }
    porContacto.set(f.customerId!, fila);
  }

  const filas = [...porContacto.values()]
    .map((f) => ({ ...f, facturado: r2(f.facturado), pagado: r2(f.pagado), saldo: r2(f.saldo), repPendiente: r2(f.repPendiente) }))
    .filter((f) => f.saldo > 1 || f.repPendiente > 1)
    .sort((a, b) => b.saldo - a.saldo);

  return NextResponse.json({
    lado,
    resumen: {
      contactos: filas.length,
      saldoTotal: r2(filas.reduce((s, f) => s + f.saldo, 0)),
      repPendienteTotal: r2(filas.reduce((s, f) => s + f.repPendiente, 0)),
    },
    filas,
  });
});
