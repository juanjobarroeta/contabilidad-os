import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/impuestos/diot?companyId=xxx&month=4&year=2026
//
// DIOT (Declaración Informativa de Operaciones con Terceros)
// Generates two things:
//   1. JSON response with supplier-level IVA breakdown (for the UI)
//   2. When format=txt, returns the SAT batch upload file (.txt)
//
// SAT DIOT format (pipe-delimited):
// 04|RFC|RAZON_SOCIAL|PAIS|||IVA_16|0|0|IVA_RETENIDO|0|0|0|0|0|0
// TipoTercero: 04=Nacional, 05=Extranjero, 15=Global (sin RFC)
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

  // Fetch all egresos (purchases) for the month with supplier and tax info
  const egresos = await prisma.invoice.findMany({
    where: {
      companyId,
      tipo: "EGRESO",
      status: "STAMPED",
      fecha: { gte: from, lt: to },
    },
    include: {
      taxes: true,
      customer: { select: { rfc: true, razonSocial: true } },
    },
  });

  // Aggregate by supplier RFC
  type SupplierRow = {
    rfc: string;
    razonSocial: string;
    tipoTercero: "04" | "05" | "15"; // Nacional, Extranjero, Global
    operaciones: number; // count of invoices
    valorActosGravados16: number; // base IVA 16%
    ivaTrasladadoPagado16: number;
    valorActosGravados0: number;
    ivaRetenido: number;
    totalPagado: number;
  };

  const byRfc = new Map<string, SupplierRow>();

  for (const inv of egresos) {
    const rfc = inv.customer?.rfc ?? "XAXX010101000";
    const razonSocial = inv.customer?.razonSocial ?? "PUBLICO EN GENERAL";

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
        ivaRetenido: 0,
        totalPagado: 0,
      });
    }

    const row = byRfc.get(rfc)!;
    row.operaciones++;
    row.totalPagado += inv.total;

    // Classify IVA from tax records
    const ivaTrasladado = inv.taxes
      .filter(t => t.tipo === "IVA" && !t.retencion)
      .reduce((s, t) => s + t.importe, 0);
    const ivaRetenido = inv.taxes
      .filter(t => t.tipo === "IVA" && t.retencion)
      .reduce((s, t) => s + t.importe, 0);

    if (ivaTrasladado > 0) {
      row.valorActosGravados16 += inv.subtotal;
      row.ivaTrasladadoPagado16 += ivaTrasladado;
    } else {
      // Tasa 0% or exento
      row.valorActosGravados0 += inv.subtotal;
    }
    row.ivaRetenido += ivaRetenido;
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
    ivaRetenido: rows.reduce((s, r) => s + r.ivaRetenido, 0),
    totalPagado: rows.reduce((s, r) => s + r.totalPagado, 0),
    proveedores: rows.length,
  };

  // SAT TXT format
  if (format === "txt") {
    const lines = rows.map(r => {
      const g16 = Math.round(r.valorActosGravados16 * 100) / 100;
      const iva16 = Math.round(r.ivaTrasladadoPagado16 * 100) / 100;
      const g0 = Math.round(r.valorActosGravados0 * 100) / 100;
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
        g16.toFixed(2),  // gravados 16%
        "0",             // gravados 15% (obsoleto)
        g0.toFixed(2),   // gravados 0%
        "0",             // exentos
        ret.toFixed(2),  // IVA retenido
        iva16.toFixed(2), // IVA trasladado
        "0",             // IEPS gravados
        "0",             // IEPS exentos
        "0",             // IVA no acreditable
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
