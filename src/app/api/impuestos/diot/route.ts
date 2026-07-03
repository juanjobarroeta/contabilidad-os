import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import {
  operacionesEgresoFlujo,
  type EgresoDelMes,
  type PpdParentEgreso,
} from "@/lib/fiscal/iva-flujo";
import { efosRfcsBloqueados } from "@/lib/fiscal/efos/service";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/impuestos/diot?companyId=xxx&month=4&year=2026
//
// DIOT (Declaración Informativa de Operaciones con Terceros)
// Generates two things:
//   1. JSON response with supplier-level IVA breakdown (for the UI)
//   2. When format=txt, returns the SAT batch upload file (.txt)
//
// Base de FLUJO DE EFECTIVO (Art. 32 fracc. VIII y Art. 1-B LIVA): la DIOT
// reporta el IVA EFECTIVAMENTE PAGADO a cada proveedor en el mes, no el
// devengado. Misma regla que el motor mensual (computeTaxPosition,
// src/lib/impuestos.ts):
//   - PUE: pagado en el mes de emisión de la factura.
//   - PPD: pagado en el mes de la FechaPago de cada pago del REP recibido; los
//     PPD sin REP NO se reportan (aún no están pagados). Pagos parciales
//     entran sólo por la porción pagada.
// La suma de ivaAcreditable del mes cuadra con iva.acreditableBruto del motor
// (el motor después aplica la proporción del Art. 5-V, que es global).
//
// SAT DIOT format (pipe-delimited):
// 04|RFC|RAZON_SOCIAL|PAIS|||IVA_16|0|0|IVA_RETENIDO|0|0|0|0|0|0
// TipoTercero: 04=Nacional, 05=Extranjero, 15=Global (sin RFC)
// NOTA: este es el layout LEGACY de carga batch. El nuevo layout DIOT 2025
// del SAT es una tarea pendiente aparte — este cambio sólo corrige las cifras.
// ─────────────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const month = parseInt(searchParams.get("month") ?? "");
  const year = parseInt(searchParams.get("year") ?? "");
  const format = searchParams.get("format"); // "txt" for SAT file

  if (!companyId || isNaN(month) || isNaN(year)) {
    return NextResponse.json({ error: "companyId, month y year requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const from = new Date(year, month - 1, 1);
  const to = new Date(year, month, 1);

  // Proveedores 69-B definitivos: su IVA NO es acreditable (Art. 69-B CFF) —
  // la operación sí se reporta, pero el IVA va como no acreditable, igual que
  // el motor mensual lo excluye del acreditable.
  const efosBloqueados = await efosRfcsBloqueados(companyId);
  const esEfos = (rfc?: string | null) =>
    efosBloqueados.size > 0 && !!rfc && efosBloqueados.has(rfc.toUpperCase().trim());

  const taxesSelect = {
    select: { tipo: true, factor: true, tasa: true, base: true, importe: true, retencion: true },
  } as const;

  // 1) Egresos EMITIDOS en el mes: sólo los PUE cuentan (pagados por emisión).
  //    Los PPD se filtran dentro del helper — entran únicamente vía REP.
  // 2) Pagos de REP (complemento de pago) con FechaPago dentro del mes.
  const [egresosDelMes, repLinksDelMes] = await Promise.all([
    prisma.invoice.findMany({
      where: {
        companyId,
        tipo: "EGRESO",
        status: "STAMPED",
        fecha: { gte: from, lt: to },
      },
      select: {
        metodoPago: true,
        subtotal: true,
        total: true,
        totalImpuestos: true,
        ivaNoAcreditable: true,
        taxes: taxesSelect,
        customer: { select: { rfc: true, razonSocial: true } },
      },
    }),
    prisma.pagoDoctoRelacionado.findMany({
      where: {
        fechaPago: { gte: from, lt: to },
        pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED" },
      },
      select: { parentUuid: true, impPagado: true, ivaTrasladado: true, ivaDerivado: true },
    }),
  ]);

  // 3) Facturas madre PPD (EGRESO) de esos pagos — mismos filtros que el motor.
  const parentUuids = [...new Set(repLinksDelMes.map((l) => l.parentUuid))];
  const ppdParentsRaw = parentUuids.length
    ? await prisma.invoice.findMany({
        where: {
          companyId,
          tipo: "EGRESO",
          uuid: { in: parentUuids },
          metodoPago: "PPD",
          status: "STAMPED",
        },
        select: {
          uuid: true,
          metodoPago: true,
          subtotal: true,
          total: true,
          totalImpuestos: true,
          ivaNoAcreditable: true,
          taxes: taxesSelect,
          customer: { select: { rfc: true, razonSocial: true } },
        },
      })
    : [];

  const egresos: EgresoDelMes[] = egresosDelMes.map((inv) => ({
    metodoPago: inv.metodoPago,
    subtotal: inv.subtotal,
    total: inv.total,
    totalImpuestos: inv.totalImpuestos,
    taxes: inv.taxes,
    ivaNoAcreditable: inv.ivaNoAcreditable || esEfos(inv.customer?.rfc),
    rfc: inv.customer?.rfc ?? null,
    razonSocial: inv.customer?.razonSocial ?? null,
  }));
  const ppdParents: PpdParentEgreso[] = ppdParentsRaw
    .filter((p) => p.uuid != null)
    .map((p) => ({
      uuid: p.uuid!,
      metodoPago: p.metodoPago,
      subtotal: p.subtotal,
      total: p.total,
      totalImpuestos: p.totalImpuestos,
      taxes: p.taxes,
      ivaNoAcreditable: p.ivaNoAcreditable || esEfos(p.customer?.rfc),
      rfc: p.customer?.rfc ?? null,
      razonSocial: p.customer?.razonSocial ?? null,
    }));

  // Operaciones efectivamente pagadas en el mes (helper puro compartido con el
  // motor mensual — ver src/lib/fiscal/iva-flujo.ts).
  const operaciones = operacionesEgresoFlujo({
    egresosDelMes: egresos,
    repLinksDelMes,
    ppdParents,
  });

  // Aggregate by supplier RFC
  type SupplierRow = {
    rfc: string;
    razonSocial: string;
    tipoTercero: "04" | "05" | "15"; // Nacional, Extranjero, Global
    operaciones: number; // count of paid operations (facturas PUE + pagos REP)
    valorActosGravados16: number; // base pagada gravada 16%
    ivaTrasladadoPagado16: number; // IVA acreditable (efectivamente pagado)
    valorActosGravados0: number; // base pagada gravada a tasa 0%
    valorActosExentos: number; // actos exentos pagados (≠ tasa 0%)
    ivaNoAcreditable: number; // IVA pagado no acreditable (bandera / 69-B)
    ivaRetenido: number;
    totalPagado: number;
  };

  const byRfc = new Map<string, SupplierRow>();

  for (const op of operaciones) {
    const rfc = op.rfc ?? "XAXX010101000";
    const razonSocial = op.razonSocial ?? "PUBLICO EN GENERAL";

    if (!byRfc.has(rfc)) {
      // Determine tipo tercero
      let tipoTercero: "04" | "05" | "15" = "04"; // Nacional
      if (rfc === "XEXX010101000" || rfc.length < 12) {
        tipoTercero = "05"; // Extranjero
      } else if (rfc === "XAXX010101000") {
        tipoTercero = "15"; // Global (sin RFC)
      }

      byRfc.set(rfc, {
        rfc,
        razonSocial,
        tipoTercero,
        operaciones: 0,
        valorActosGravados16: 0,
        ivaTrasladadoPagado16: 0,
        valorActosGravados0: 0,
        valorActosExentos: 0,
        ivaNoAcreditable: 0,
        ivaRetenido: 0,
        totalPagado: 0,
      });
    }

    const row = byRfc.get(rfc)!;
    row.operaciones++;
    row.totalPagado += op.totalPagado;
    row.valorActosGravados16 += op.base16Pagada;
    row.ivaTrasladadoPagado16 += op.ivaAcreditable;
    row.valorActosGravados0 += op.base0Pagada;
    row.valorActosExentos += op.exentosPagados;
    row.ivaNoAcreditable += op.ivaNoAcreditable;
    row.ivaRetenido += op.ivaRetenido;
  }

  const rows = Array.from(byRfc.values()).sort((a, b) =>
    b.ivaTrasladadoPagado16 - a.ivaTrasladadoPagado16
  );

  // Totals
  const totals = {
    operaciones: rows.reduce((s, r) => s + r.operaciones, 0),
    valorActosGravados16: rows.reduce((s, r) => s + r.valorActosGravados16, 0),
    ivaTrasladadoPagado16: rows.reduce((s, r) => s + r.ivaTrasladadoPagado16, 0),
    valorActosGravados0: rows.reduce((s, r) => s + r.valorActosGravados0, 0),
    valorActosExentos: rows.reduce((s, r) => s + r.valorActosExentos, 0),
    ivaNoAcreditable: rows.reduce((s, r) => s + r.ivaNoAcreditable, 0),
    ivaRetenido: rows.reduce((s, r) => s + r.ivaRetenido, 0),
    totalPagado: rows.reduce((s, r) => s + r.totalPagado, 0),
    proveedores: rows.length,
  };

  // SAT TXT format (layout legacy de carga batch — el layout DIOT 2025 es una
  // tarea pendiente aparte; aquí sólo se corrigen las cifras a base de flujo).
  if (format === "txt") {
    const lines = rows.map(r => {
      const g16 = Math.round(r.valorActosGravados16 * 100) / 100;
      const iva16 = Math.round(r.ivaTrasladadoPagado16 * 100) / 100;
      const g0 = Math.round(r.valorActosGravados0 * 100) / 100;
      const ex = Math.round(r.valorActosExentos * 100) / 100;
      const noAcred = Math.round(r.ivaNoAcreditable * 100) / 100;
      const ret = Math.round(r.ivaRetenido * 100) / 100;

      // SAT DIOT format: 15 pipe-delimited fields
      // TipoTercero|RFC|RazonSocial|PaisResidencia|Nacionalidad|
      // ValorActosGravados16|ValorActosGravados15|ValorActosGravados0|
      // ValorActosExentos|IVARetenido|IVATrasladado|
      // ValorActosGravadosIEPS|ValorActosExentosIEPS|
      // IVANoAcreditable|ValorActosNoObjeto
      return [
        r.tipoTercero,
        r.rfc,
        r.razonSocial.substring(0, 300),
        "", // país
        "", // nacionalidad
        g16.toFixed(2),  // gravados 16% (base pagada)
        "0",             // gravados 15% (obsoleto)
        g0.toFixed(2),   // gravados 0% (base pagada, ≠ exentos)
        ex.toFixed(2),   // exentos (sin traslado de IVA o TipoFactor=Exento)
        ret.toFixed(2),  // IVA retenido
        iva16.toFixed(2), // IVA trasladado (acreditable, efectivamente pagado)
        "0",             // IEPS gravados
        "0",             // IEPS exentos
        noAcred.toFixed(2), // IVA no acreditable (bandera manual / 69-B)
        "0",             // no objeto
      ].join("|");
    });

    const content = lines.join("\r\n");
    const periodo = `${year}${String(month).padStart(2, "0")}`;
    const filename = `DIOT_${periodo}.txt`;

    return new Response(content, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  return NextResponse.json({
    periodo: `${year}-${String(month).padStart(2, "0")}`,
    rows,
    totals,
  });
}
