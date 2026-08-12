import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";
import { toCsv, type CsvRow } from "@/lib/csv";
import { calcularActosDelPeriodo } from "@/lib/fiscal/iva";
import { reconciliacionActiva, pagosConciliadosPorInvoice, pagadaCompleta } from "@/lib/fiscal/conciliacion-pue";
import { repIvaAcreditableDe } from "@/lib/impuestos";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";
import { esConceptoExcluido, UMBRAL_MONTO } from "@/lib/fiscal/audit/ingreso-no-facturado";
import { nombreContraparte, rfcContraparte } from "@/lib/facturas/contraparte";

// GET /api/papeles/iva?companyId=xxx&year=2026&month=3[&format=csv]
//
// Papel de trabajo del IVA mensual — detalle por factura de cada renglón
// que alimenta el cálculo que ven los contadores cuando hacen el proceso
// manualmente.
//
// Estructura de respuesta JSON:
//   {
//     periodo: "2026-03",
//     trasladado: Row[],     // INGRESOS: IVA cobrado
//     acreditable: Row[],    // EGRESOS: IVA pagado acreditable
//     retenidoPorClientes: Row[],  // clientes que nos retuvieron IVA
//     retenidoAProveedores: Row[], // nosotros retuvimos IVA a proveedores
//     totales: {
//       trasladado: number,
//       acreditable: number,
//       retenidoPorClientes: number,
//       retenidoAProveedores: number,
//       ivaCargo: number,     // lo que potencialmente debemos
//       saldoFavorAnterior: number,
//       ivaPagar: number,
//       saldoFavorMes: number,
//     },
//   }
//
// Pasa ?format=csv para descarga directa.
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = parseInt(searchParams.get("year") ?? "");
  const month = parseInt(searchParams.get("month") ?? "");
  const format = searchParams.get("format");

  if (!companyId || isNaN(year) || isNaN(month)) {
    return NextResponse.json({ error: "companyId, year, month requeridos" }, { status: 400 });
  }

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const from = new Date(Date.UTC(year, month - 1, 1));
  const to = new Date(Date.UTC(year, month, 1));
  const periodo = `${year}-${String(month).padStart(2, "0")}`;

  // Previous month's declaration for saldo a favor carryover
  const prevPeriodo = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;

  const [ingresos, egresos, prevDecl, curDecl, company, repCobros] = await Promise.all([
    prisma.invoice.findMany({
      where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: { customer: { select: { razonSocial: true, rfc: true } }, taxes: true },
      orderBy: { fecha: "asc" },
    }),
    prisma.invoice.findMany({
      where: { companyId, tipo: "EGRESO", status: "STAMPED", fecha: { gte: from, lt: to } },
      include: { customer: { select: { razonSocial: true, rfc: true } }, taxes: true },
      orderBy: { fecha: "asc" },
    }),
    prisma.taxDeclaration.findFirst({
      where: {
        companyId,
        tipo: "IVA_MENSUAL",
        periodo: prevPeriodo,
        status: { in: ["CALCULATED", "FILED", "PAID"] },
      },
    }),
    // Declaración del periodo actual: lleva el override manual del saldo a favor
    // anterior (campo ivaSaldoFavorAnterior) que el contador captura en la
    // pantalla de detalle. Misma fuente, misma persistencia — no se duplica.
    prisma.taxDeclaration.findFirst({
      where: { companyId, tipo: "IVA_MENSUAL", periodo },
      select: { ivaSaldoFavorAnterior: true },
    }),
    prisma.company.findUnique({
      where: { id: companyId },
      select: { rfc: true, razonSocial: true },
    }),
    // Complementos de pago (REP) liquidados en el periodo: definen qué PPD se
    // vuelve acreditable este mes (igual que el motor). parentUuid = UUID del CFDI pagado.
    prisma.pagoDoctoRelacionado.findMany({
      where: { fechaPago: { gte: from, lt: to }, pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED" } },
      select: { parentUuid: true, impPagado: true, ivaTrasladado: true, ivaDerivado: true, fechaPago: true },
    }),
  ]);
  // REP links liquidados en el periodo, agrupados por CFDI pagado (parentUuid).
  type RepLink = { impPagado: number | null; ivaTrasladado: number | null; ivaDerivado: boolean; fechaPago: Date | null };
  // Llaves NORMALIZADAS: el REP escribe IdDocumento en MAYÚSCULAS y las
  // facturas del PAC se guardan en minúsculas (src/lib/fiscal/uuid.ts) — sin
  // normalizar, los cobros reales se descartaban como "padre desconocido".
  const repLinksPorParent = new Map<string, RepLink[]>();
  for (const r of repCobros) {
    const k = normalizarUuid(r.parentUuid);
    repLinksPorParent.set(k, [...(repLinksPorParent.get(k) ?? []), r]);
  }
  // Padres INGRESO (de cualquier mes) de los REP cobrados este periodo: su IVA
  // se causa al COBRARSE (flujo), no en la fecha del CFDI — igual que el motor.
  // Por eso el PPD ingreso se arma desde los complementos, no desde la lista por
  // fecha (capta también lo cobrado este mes de facturas de meses anteriores).
  const repParentUuids = variantesUuid(repCobros.map((r) => r.parentUuid));
  const repIngresoParents = repParentUuids.length
    ? await prisma.invoice.findMany({
        where: { companyId, uuid: { in: repParentUuids }, tipo: "INGRESO", metodoPago: "PPD", status: "STAMPED" },
        select: { id: true, uuid: true, serie: true, folio: true, total: true, totalImpuestos: true, taxes: true, ivaNoCausado: true, customer: { select: { razonSocial: true, rfc: true } } },
      })
    : [];
  const repIngresoByUuid = new Map(repIngresoParents.map((p) => [normalizarUuid(p.uuid!), p]));

  type InvoiceRelation = (typeof ingresos)[number];

  // Extract the IVA components per invoice. When InvoiceTax rows exist we
  // trust them (they match the XML exactly). Otherwise we fall back to
  // totalImpuestos stored at the header.
  function extractIva(inv: InvoiceRelation) {
    const ivaRows = inv.taxes.filter((t) => t.tipo === "IVA");
    if (ivaRows.length > 0) {
      const trasladadoRows = ivaRows.filter((t) => !t.retencion);
      const retenidoRows = ivaRows.filter((t) => t.retencion);
      return {
        trasladado: trasladadoRows.reduce((s, t) => s + t.importe, 0),
        retenido: retenidoRows.reduce((s, t) => s + t.importe, 0),
      };
    }
    // Fallback: totalImpuestos. Positive = net trasladado, negative = net retenido.
    const ti = inv.totalImpuestos ?? 0;
    return {
      trasladado: ti > 0 ? ti : 0,
      retenido: ti < 0 ? -ti : 0,
    };
  }

  type Row = {
    id: string;
    fecha: string;
    uuid: string | null;
    serie: string | null;
    folio: string | null;
    contraparte: string;
    rfc: string;
    subtotal: number;
    tasa: number | null;
    importe: number;
    metodoPago: string;
    /** PUE acreditable sin pago conciliado en banco (cash-basis, Art. 5-I LIVA). */
    sinPagoConciliado?: boolean;
    /** PUE acreditable con pago conciliado en banco (lo opuesto a sinPagoConciliado). */
    pagadaConciliada?: boolean;
    /** El contador excluyó este CFDI del acreditamiento de IVA. */
    excluidoAcreditamiento?: boolean;
    /** PPD sin complemento de pago (REP) en el periodo → aún no acreditable. */
    sinComplementoPago?: boolean;
    /** PPD con complemento parcial → sólo se acredita el IVA del monto pagado. */
    pagoParcial?: boolean;
    /** Renglón de ingreso PPD armado desde el complemento de pago (REP) cobrado. */
    esComplemento?: boolean;
  };

  const trasladado: Row[] = [];
  const retenidoPorClientes: Row[] = [];

  for (const inv of ingresos) {
    const { trasladado: t, retenido: r } = extractIva(inv);
    // PUE causa al emitirse; PPD causa al cobrarse (se arma abajo desde los REP).
    if (t > 0.005 && inv.metodoPago !== "PPD") {
      trasladado.push({
        id: inv.id,
        fecha: inv.fecha.toISOString().slice(0, 10),
        uuid: inv.uuid,
        serie: inv.serie,
        folio: inv.folio,
        contraparte: nombreContraparte(inv),
        rfc: rfcContraparte(inv),
        subtotal: inv.subtotal,
        tasa: inv.subtotal > 0 ? +(t / inv.subtotal).toFixed(4) : null,
        importe: t,
        metodoPago: inv.metodoPago,
        // El contador marcó el ingreso como no cobrado → no se causa IVA aún.
        excluidoAcreditamiento: inv.ivaNoCausado,
      });
    }
    if (r > 0.005) {
      retenidoPorClientes.push({
        id: inv.id,
        fecha: inv.fecha.toISOString().slice(0, 10),
        uuid: inv.uuid,
        serie: inv.serie,
        folio: inv.folio,
        contraparte: nombreContraparte(inv),
        rfc: rfcContraparte(inv),
        subtotal: inv.subtotal,
        tasa: inv.subtotal > 0 ? +(r / inv.subtotal).toFixed(4) : null,
        importe: r,
        metodoPago: inv.metodoPago,
      });
    }
  }

  // PPD ingreso cobrado este periodo (vía REP), por CFDI padre — prorrateado por
  // lo cobrado, igual que el motor. Capta también lo cobrado de meses anteriores.
  for (const [parentUuid, links] of repLinksPorParent) {
    const parent = repIngresoByUuid.get(parentUuid);
    if (!parent) continue; // el padre no es INGRESO PPD (será un egreso) → se ignora aquí
    const iva = links.reduce(
      (s, l) => s + repIvaAcreditableDe(l, { taxes: parent.taxes, totalImpuestos: parent.totalImpuestos, total: parent.total }),
      0
    );
    if (iva <= 0.005) continue;
    const ultimoPago = links.map((l) => l.fechaPago).filter(Boolean).sort().pop() ?? null;
    trasladado.push({
      id: `${parent.id}-rep`,
      fecha: (ultimoPago ?? from).toISOString().slice(0, 10),
      uuid: parent.uuid,
      serie: parent.serie,
      folio: parent.folio,
      contraparte: nombreContraparte(parent),
      rfc: rfcContraparte(parent),
      subtotal: +(iva / 0.16).toFixed(2),
      tasa: 0.16,
      importe: iva,
      metodoPago: "PPD",
      esComplemento: true,
      excluidoAcreditamiento: parent.ivaNoCausado,
    });
  }
  // Ingresos PPD emitidos en el periodo aún SIN cobro: su IVA se causa al
  // cobrarse, no al emitir. Se muestran tenues y fuera del total para que no
  // queden invisibles (espejo del "sin complemento" del lado acreditable).
  // "Sin cobro" = sin NINGÚN REP hasta el fin del periodo: si ya se pagó (este
  // mes o uno anterior) su IVA se reconoce en el mes del pago, no aquí — así un
  // PPD pagado en otro mes no se marca falsamente como pendiente.
  const ppdIngresoUuids = ingresos
    .filter((i) => i.metodoPago === "PPD" && i.uuid)
    .map((i) => i.uuid!);
  // Empate por UUID normalizado (REP en MAYÚSCULAS vs PAC en minúsculas): sin
  // esto, una PPD YA cobrada seguía apareciendo "sin complemento" (tenue) junto
  // a su renglón cobrado (REP) — parecía duplicada aunque el total era correcto.
  const pagadosHastaPeriodo = ppdIngresoUuids.length
    ? new Set(
        (
          await prisma.pagoDoctoRelacionado.findMany({
            where: {
              parentUuid: { in: variantesUuid(ppdIngresoUuids) },
              fechaPago: { lt: to },
              pagoInvoice: { companyId, tipo: "PAGO", status: "STAMPED" },
            },
            select: { parentUuid: true },
          })
        ).map((r) => normalizarUuid(r.parentUuid))
      )
    : new Set<string>();
  for (const inv of ingresos) {
    if (inv.metodoPago !== "PPD") continue;
    if (inv.uuid && pagadosHastaPeriodo.has(normalizarUuid(inv.uuid))) continue;
    const { trasladado: t } = extractIva(inv);
    if (t <= 0.005) continue;
    trasladado.push({
      id: `${inv.id}-pend`,
      fecha: inv.fecha.toISOString().slice(0, 10),
      uuid: inv.uuid,
      serie: inv.serie,
      folio: inv.folio,
      contraparte: nombreContraparte(inv),
      rfc: rfcContraparte(inv),
      subtotal: inv.subtotal,
      tasa: inv.subtotal > 0 ? +(t / inv.subtotal).toFixed(4) : null,
      importe: t,
      metodoPago: "PPD",
      sinComplementoPago: true,
    });
  }
  trasladado.sort((a, b) => a.fecha.localeCompare(b.fecha));

  const acreditable: Row[] = [];
  const retenidoAProveedores: Row[] = [];

  for (const inv of egresos) {
    const { trasladado: t, retenido: r } = extractIva(inv);
    if (t > 0.005) {
      // PPD sólo es acreditable cuando llega su complemento de pago (REP), y por
      // el monto pagado (prorrateado) — exactamente como el motor. Sin REP en el
      // mes: aún no acreditable. PUE: el IVA completo del CFDI.
      const esPPD = inv.metodoPago === "PPD";
      const links = inv.uuid ? repLinksPorParent.get(normalizarUuid(inv.uuid)) : undefined;
      const acreditadoPPD = esPPD && links
        ? links.reduce((s, l) => s + repIvaAcreditableDe(l, { taxes: inv.taxes, totalImpuestos: inv.totalImpuestos, total: inv.total }), 0)
        : 0;
      // Con pago: el IVA prorrateado acreditable. Sin pago: mostramos el IVA
      // completo (tachado, fuera del total) para que se vea lo pendiente.
      const importe = esPPD ? (acreditadoPPD > 0.005 ? acreditadoPPD : t) : t;
      acreditable.push({
        id: inv.id,
        fecha: inv.fecha.toISOString().slice(0, 10),
        uuid: inv.uuid,
        serie: inv.serie,
        folio: inv.folio,
        contraparte: nombreContraparte(inv),
        rfc: rfcContraparte(inv),
        subtotal: inv.subtotal,
        tasa: inv.subtotal > 0 ? +(t / inv.subtotal).toFixed(4) : null,
        importe,
        metodoPago: inv.metodoPago,
        excluidoAcreditamiento: inv.ivaNoAcreditable,
        sinComplementoPago: esPPD && acreditadoPPD <= 0.005,
        pagoParcial: esPPD && acreditadoPPD > 0.005 && acreditadoPPD + 0.5 < t,
      });
    }
    if (r > 0.005) {
      retenidoAProveedores.push({
        id: inv.id,
        fecha: inv.fecha.toISOString().slice(0, 10),
        uuid: inv.uuid,
        serie: inv.serie,
        folio: inv.folio,
        contraparte: nombreContraparte(inv),
        rfc: rfcContraparte(inv),
        subtotal: inv.subtotal,
        tasa: inv.subtotal > 0 ? +(r / inv.subtotal).toFixed(4) : null,
        importe: r,
        metodoPago: inv.metodoPago,
      });
    }
  }

  const sum = (rs: Row[]) => rs.reduce((s, r) => s + r.importe, 0);
  // Lo marcado como no cobrado (ivaNoCausado) no causa IVA aún — fuera del total.
  // Tampoco el PPD ingreso aún sin cobrar (sin REP): su IVA se causa al cobrarse.
  const totalTrasladado = sum(trasladado.filter((r) => !r.excluidoAcreditamiento && !r.sinComplementoPago));
  const ppdIngRows = trasladado.filter((r) => r.sinComplementoPago);
  const ppdIngresoPendiente = { count: ppdIngRows.length, iva: +sum(ppdIngRows).toFixed(2) };
  // No entran al total (ni al cálculo) — igual que el motor: lo excluido por el
  // contador, ni el PPD que aún no tiene complemento de pago en el periodo.
  const totalAcreditable = sum(acreditable.filter((r) => !r.excluidoAcreditamiento && !r.sinComplementoPago));
  const ppdRows = acreditable.filter((r) => r.sinComplementoPago);
  const ppdSinComplemento = { count: ppdRows.length, iva: +sum(ppdRows).toFixed(2) };
  const totalRetenidoClientes = sum(retenidoPorClientes);
  const totalRetenidoProv = sum(retenidoAProveedores);

  // Proporción de acreditamiento (Art. 5-V LIVA): con actos exentos en el mes,
  // el IVA acreditable sólo procede en gravados/(gravados+exentos). Mismo
  // helper que el motor (computeTaxPosition) para no divergir.
  const actos = calcularActosDelPeriodo(ingresos);
  const acreditableProcedente = +(totalAcreditable * actos.proporcion).toFixed(2);

  // IVA cargo = trasladado - retenidoPorClientes - acreditable procedente
  const ivaCargo = totalTrasladado - totalRetenidoClientes - acreditableProcedente;
  // Saldo a favor anterior: por defecto se arrastra el saldo a favor que dejó la
  // declaración del mes previo (ivaSaldoFavor). El contador puede ajustarlo a mano
  // y ese override se guarda en ivaSaldoFavorAnterior de la declaración del periodo
  // (misma fuente que la pantalla de detalle). Cuando existe el override, manda.
  const saldoFavorAnteriorAuto = prevDecl?.ivaSaldoFavor ?? 0;
  const saldoFavorAnteriorOverride = curDecl?.ivaSaldoFavorAnterior ?? null;
  const saldoFavorAnterior = saldoFavorAnteriorOverride ?? saldoFavorAnteriorAuto;
  const cargoFinal = ivaCargo - saldoFavorAnterior;
  const ivaPagar = cargoFinal > 0 ? cargoFinal : 0;
  const saldoFavorMes = cargoFinal < 0 ? -cargoFinal : 0;

  // PUE acreditado sin pago conciliado (cash-basis, Art. 5-I LIVA). El motor
  // asume el PUE pagado al emitirse; sólo si la empresa concilia banco podemos
  // marcar los que no aparecen pagados. Si no concilia, no marcamos nada.
  const reconActiva = await reconciliacionActiva(companyId);
  let ivaPueSinPago = 0;
  let cfdisPueSinPago = 0;
  if (reconActiva) {
    const totalById = new Map(egresos.map((e) => [e.id, e.total]));
    const pueRows = acreditable.filter((r) => r.metodoPago === "PUE" && !r.excluidoAcreditamiento);
    const matched = await pagosConciliadosPorInvoice(pueRows.map((r) => r.id));
    for (const r of pueRows) {
      if (!pagadaCompleta(totalById.get(r.id) ?? 0, matched.get(r.id) ?? 0)) {
        r.sinPagoConciliado = true;
        ivaPueSinPago += r.importe;
        cfdisPueSinPago += 1;
      } else {
        // Pago conciliado completo en banco → marca verde "pagada" (lo opuesto
        // a "sin pago"), para que el contador vea de un vistazo qué PUE ya está
        // respaldado por un movimiento bancario.
        r.pagadaConciliada = true;
      }
    }
  }

  // Cobros bancarios del PERIODO sin CFDI que los respalde. El IVA se causa al
  // cobro (Art. 1-B LIVA) exista o no la factura, así que un depósito sin
  // conciliar es IVA potencialmente omitido en ESTE mes — la advertencia vive
  // junto al cálculo porque aquí es donde se firma la declaración (el hallazgo
  // de Revisión existe, pero llega tarde si nadie abre esa pestaña). Mismos
  // candados anti-ruido que el check banco.ingreso_no_facturado.
  const depositosDelPeriodo = reconActiva
    ? (
        await prisma.bankTransaction.findMany({
          where: {
            companyId,
            tipo: "CREDITO",
            status: "UNMATCHED",
            invoiceId: null,
            monto: { gte: UMBRAL_MONTO },
            fecha: { gte: from, lt: to },
          },
          select: { monto: true, descripcion: true },
        })
      ).filter((r) => !esConceptoExcluido(r.descripcion))
    : [];
  const depositosSinFacturaTotal = depositosDelPeriodo.reduce((s, d) => s + d.monto, 0);
  const depositosSinFactura = {
    count: depositosDelPeriodo.length,
    total: +depositosSinFacturaTotal.toFixed(2),
    // IVA implícito si esos cobros fueran gravados al 16% (el depósito incluye IVA).
    ivaPotencial: +((depositosSinFacturaTotal * 0.16) / 1.16).toFixed(2),
  };

  const payload = {
    periodo,
    company: company ? { rfc: company.rfc, razonSocial: company.razonSocial } : null,
    trasladado,
    acreditable,
    retenidoPorClientes,
    retenidoAProveedores,
    totales: {
      trasladado: totalTrasladado,
      acreditable: totalAcreditable,
      proporcionAcreditamiento: actos.proporcion,
      actosGravados: actos.gravados,
      actosExentos: actos.exentos,
      acreditableProcedente,
      retenidoPorClientes: totalRetenidoClientes,
      retenidoAProveedores: totalRetenidoProv,
      ivaCargo,
      saldoFavorAnterior,
      // Valor automático arrastrado del mes anterior y override manual capturado
      // (null si no hay) — el editor inline los necesita para mostrar la fuente y
      // ofrecer "restablecer al automático".
      saldoFavorAnteriorAuto,
      saldoFavorAnteriorOverride,
      saldoFavorAnteriorPeriodo: saldoFavorAnteriorAuto > 0 ? prevPeriodo : null,
      saldoFavorAnteriorEsManual: saldoFavorAnteriorOverride != null,
      ivaPagar,
      saldoFavorMes,
    },
    reconciliacion: {
      activa: reconActiva,
      ivaPueSinPago: +ivaPueSinPago.toFixed(2),
      cfdisPueSinPago,
    },
    ppdSinComplemento,
    ppdIngresoPendiente,
    depositosSinFactura,
  };

  if (format === "csv") {
    const headers = [
      "Sección",
      "Fecha",
      "UUID",
      "Serie",
      "Folio",
      "Contraparte",
      "RFC",
      "Subtotal",
      "Tasa",
      "IVA importe",
      "Método pago",
    ];

    const section = (label: string, rows: Row[]): CsvRow[] =>
      rows.map((r) => [
        label,
        r.fecha,
        r.uuid ?? "",
        r.serie ?? "",
        r.folio ?? "",
        r.contraparte,
        r.rfc,
        r.subtotal.toFixed(2),
        r.tasa != null ? (r.tasa * 100).toFixed(2) + "%" : "",
        r.importe.toFixed(2),
        r.metodoPago,
      ]);

    const rows: CsvRow[] = [
      ...section("IVA trasladado (cobrado)", trasladado),
      ...section("IVA acreditable (pagado)", acreditable),
      ...section("IVA retenido por clientes", retenidoPorClientes),
      ...section("IVA retenido a proveedores", retenidoAProveedores),
      [], // blank row
      ["TOTALES"],
      ["Total IVA trasladado", "", "", "", "", "", "", "", "", totalTrasladado.toFixed(2), ""],
      ["Total IVA acreditable", "", "", "", "", "", "", "", "", totalAcreditable.toFixed(2), ""],
      ...(actos.proporcion < 1
        ? ([
            ["Actos gravados del mes (16%/0%)", "", "", "", "", "", "", "", "", actos.gravados.toFixed(2), ""],
            ["Actos exentos del mes", "", "", "", "", "", "", "", "", actos.exentos.toFixed(2), ""],
            ["Proporción de acreditamiento (Art. 5-V LIVA)", "", "", "", "", "", "", "", "", (actos.proporcion * 100).toFixed(4) + "%", ""],
            ["IVA acreditable procedente", "", "", "", "", "", "", "", "", acreditableProcedente.toFixed(2), ""],
          ] as CsvRow[])
        : []),
      ["Total IVA retenido por clientes", "", "", "", "", "", "", "", "", totalRetenidoClientes.toFixed(2), ""],
      ["Total IVA retenido a proveedores", "", "", "", "", "", "", "", "", totalRetenidoProv.toFixed(2), ""],
      ["IVA a cargo (antes de saldo a favor)", "", "", "", "", "", "", "", "", ivaCargo.toFixed(2), ""],
      ["Saldo a favor anterior", "", "", "", "", "", "", "", "", saldoFavorAnterior.toFixed(2), ""],
      ["IVA A PAGAR", "", "", "", "", "", "", "", "", ivaPagar.toFixed(2), ""],
      ["Saldo a favor del mes", "", "", "", "", "", "", "", "", saldoFavorMes.toFixed(2), ""],
    ];

    const csv = toCsv(headers, rows);
    const filename = `papel_iva_${company?.rfc ?? ""}_${periodo}.csv`;
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  return NextResponse.json(payload);
}
