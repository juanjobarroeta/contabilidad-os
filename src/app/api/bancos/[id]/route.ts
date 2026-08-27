import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getEffectiveCompanyMembership, requireUser, AuthzError } from "@/lib/authz";
import {
  DEVOLUCION_VENTANA_DIAS,
  elegirOrigenDevolucion,
  esDescripcionDevolucion,
} from "@/lib/bancos/devoluciones";

type Params = { params: Promise<{ id: string }> };

// GET /api/bancos/[id]?status=UNMATCHED|MATCHED|IGNORED|PENDING&page=1&pageSize=50&mes=YYYY-MM
// PENDING = IGNORED rows with notes = "PENDING_MONTHLY_CFDI" (bank fees waiting
// for the consolidated monthly CFDI from the bank).
// mes acota movimientos Y conteos a ese mes calendario (UTC) — el workbench de
// conciliación de ZionX trabaja mes por mes.
// Autz: sesión web O token de servicio (Bearer) — ZionX espeja los movimientos.
export async function GET(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id: bankAccountId } = await params;
  const { searchParams } = new URL(req.url);
  const status   = searchParams.get("status") ?? undefined;
  const page     = parseInt(searchParams.get("page") ?? "1");
  const pageSize = parseInt(searchParams.get("pageSize") ?? "50");
  const mes      = searchParams.get("mes") ?? "";
  let fechaMes: { gte: Date; lt: Date } | undefined;
  if (/^\d{4}-\d{2}$/.test(mes)) {
    const [y, m] = mes.split("-").map(Number);
    fechaMes = { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
  }

  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "Cuenta no encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(user.id, account.companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  // Tag-based subcategories of IGNORED that we surface as their own tabs.
  // Anything else with status=IGNORED falls into the plain "Ignorados" tab.
  const TAG_TABS: Record<string, string> = {
    PENDING:              "PENDING_MONTHLY_CFDI",
    TAX_PAYMENT:          "TAX_PAYMENT",
    PAYROLL_NO_CFDI:      "PAYROLL_NO_CFDI",
    LOAN_RECEIVED:        "LOAN_RECEIVED",
    LOAN_GIVEN:           "LOAN_GIVEN",
    CAPITAL_CONTRIBUTION: "CAPITAL_CONTRIBUTION",
    NON_DEDUCTIBLE:       "NON_DEDUCTIBLE",
    INTERNAL_TRANSFER:    "INTERNAL_TRANSFER",
  };
  const knownTags = Object.values(TAG_TABS);

  const scope: Prisma.BankTransactionWhereInput = fechaMes
    ? { bankAccountId, fecha: fechaMes }
    : { bankAccountId };
  let where: Prisma.BankTransactionWhereInput = { ...scope };
  if (status && status in TAG_TABS) {
    where = { ...scope, status: "IGNORED", notes: TAG_TABS[status] };
  } else if (status === "IGNORED") {
    // Plain Ignorados = IGNORED rows whose notes is null or some other tag
    where = {
      ...scope,
      status: "IGNORED",
      OR: [{ notes: null }, { notes: { notIn: knownTags } }],
    };
  } else if (status && status !== "all") {
    // "all" (o sin status) = todos los movimientos, sin filtro de estado.
    // Cualquier otro valor es un estado del enum (UNMATCHED/MATCHED/IGNORED).
    where = { ...scope, status: status as "UNMATCHED" | "MATCHED" | "IGNORED" };
  }

  const [transactions, total] = await Promise.all([
    prisma.bankTransaction.findMany({
      where,
      include: {
        invoice: {
          select: {
            id: true,
            uuid: true,
            folio: true,
            serie: true,
            total: true,
            fecha: true,
            customer: { select: { razonSocial: true } },
          },
        },
        // Pago de impuestos conciliado: la UI muestra «Pago de impuestos:
        // {etiqueta del periodo/tipo}» con opción de desconciliar.
        taxDeclaration: {
          select: { id: true, tipo: true, periodo: true, status: true, fechaLimitePago: true },
        },
        // Devolución bancaria vinculada (cualquiera de los dos lados del par).
        devolucionDe: { select: { id: true, fecha: true, descripcion: true, monto: true } },
        devolucionPor: { select: { id: true, fecha: true, descripcion: true, monto: true } },
        // Comisión por transferencia: de qué envío viene (si este movimiento ES
        // la comisión) y qué cobros generó (si ES la transferencia). No se
        // netean — la comisión bancaria es un gasto real y deducible; el
        // vínculo sólo dice de dónde sale.
        comisionDe: {
          select: { id: true, fecha: true, monto: true, contraparteNombre: true, descripcion: true },
        },
        comisiones: { select: { id: true, monto: true, descripcion: true } },
        // Conciliación uno-a-varios: porciones asignadas a varias facturas
        // (la UI muestra "Conciliado con N facturas" con este detalle).
        conciliacionDetalles: {
          select: {
            id: true,
            montoAsignado: true,
            invoice: {
              select: { id: true, uuid: true, folio: true, serie: true, total: true, customer: { select: { razonSocial: true } } },
            },
          },
        },
        // Include construcción-side links so the bancos UI can show
        // "↳ Gasto / Reembolso / Raya" descriptors next to txs that
        // bartiz already linked.
        gastoPagado: {
          select: {
            id: true,
            beneficiarioNombre: true,
            importe: true,
            descripcion: true,
            proyecto: { select: { codigo: true } },
          },
        },
        reembolsoPagado: {
          select: {
            id: true,
            totalReembolso: true,
            semanaInicio: true,
            semanaFin: true,
            proyecto: { select: { codigo: true } },
          },
        },
        rayaPagada: {
          select: {
            id: true,
            totalDestajo: true,
            cuadrilla: { select: { nombre: true } },
            proyecto: { select: { codigo: true } },
          },
        },
      },
      orderBy: { fecha: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.bankTransaction.count({ where }),
  ]);

  // Status counts — group by status, then split IGNORED into its tagged subcategories
  const [counts, tagCounts, mesesRaw] = await Promise.all([
    prisma.bankTransaction.groupBy({
      by: ["status"],
      where: scope,
      _count: true,
    }),
    prisma.bankTransaction.groupBy({
      by: ["notes"],
      where: { ...scope, status: "IGNORED" },
      _count: true,
    }),
    // Meses con movimientos (SIN el filtro de mes — alimenta el selector).
    // fecha se guarda como instante UTC en columna timestamp, así que to_char
    // directo coincide con el corte Date.UTC del filtro `mes` de arriba.
    prisma.$queryRaw<{ mes: string; n: bigint }[]>`
      SELECT to_char(fecha, 'YYYY-MM') AS mes, COUNT(*) AS n
      FROM "BankTransaction"
      WHERE "bankAccountId" = ${bankAccountId}
      GROUP BY 1
      ORDER BY 1 DESC`,
  ]);
  const statusCounts = Object.fromEntries(counts.map(c => [c.status, c._count]));
  const tagCountMap = Object.fromEntries(
    tagCounts.map(c => [c.notes ?? "__null__", c._count])
  );

  const subCounts = {
    PENDING:              tagCountMap["PENDING_MONTHLY_CFDI"] ?? 0,
    TAX_PAYMENT:          tagCountMap["TAX_PAYMENT"] ?? 0,
    PAYROLL_NO_CFDI:      tagCountMap["PAYROLL_NO_CFDI"] ?? 0,
    LOAN_RECEIVED:        tagCountMap["LOAN_RECEIVED"] ?? 0,
    LOAN_GIVEN:           tagCountMap["LOAN_GIVEN"] ?? 0,
    CAPITAL_CONTRIBUTION: tagCountMap["CAPITAL_CONTRIBUTION"] ?? 0,
    NON_DEDUCTIBLE:       tagCountMap["NON_DEDUCTIBLE"] ?? 0,
    INTERNAL_TRANSFER:    tagCountMap["INTERNAL_TRANSFER"] ?? 0,
  };
  const taggedTotal = Object.values(subCounts).reduce((s, n) => s + n, 0);

  // ── Sugerencias de devolución (pago rebotado) ─────────────────────────────
  // Para los movimientos de la página cuya descripción huele a devolución y
  // que aún no están vinculados ni conciliados, se busca en la MISMA cuenta el
  // pago original (monto opuesto, ≤30 días antes). Sólo se propone con señal
  // fuerte (referencia idéntica, o descripción + cercanía); el humano decide.
  const sugerenciasDevolucion: Record<
    string,
    { origenId: string; descripcion: string; fecha: Date; monto: number }
  > = {};
  const candidatasDevolucion = transactions.filter(
    (t) =>
      esDescripcionDevolucion(t.descripcion) &&
      !t.devolucionDeId &&
      !t.devolucionPor &&
      t.status !== "MATCHED",
  );
  for (const dev of candidatasDevolucion) {
    const desde = new Date(dev.fecha.getTime() - DEVOLUCION_VENTANA_DIAS * 86400000);
    const posibles = (await prisma.bankTransaction.findMany({
      where: {
        bankAccountId,
        id: { not: dev.id },
        fecha: { gte: desde, lte: dev.fecha },
        // Monto opuesto exacto (el validador re-verifica con tolerancia).
        monto: -Number(dev.monto),
        devolucionDeId: null,
        devolucionPor: { is: null },
      },
      select: { id: true, bankAccountId: true, fecha: true, monto: true, descripcion: true, referencia: true },
      take: 20,
    })).map((p) => ({ ...p, monto: Number(p.monto) }));
    const origen = elegirOrigenDevolucion(
      { id: dev.id, bankAccountId: dev.bankAccountId, fecha: dev.fecha, monto: Number(dev.monto), descripcion: dev.descripcion, referencia: dev.referencia },
      posibles,
    );
    if (origen) {
      const full = posibles.find((p) => p.id === origen.id)!;
      sugerenciasDevolucion[dev.id] = {
        origenId: full.id,
        descripcion: full.descripcion,
        fecha: full.fecha,
        monto: full.monto,
      };
    }
  }

  return NextResponse.json({
    account,
    transactions: transactions.map((t) => ({
      ...t,
      sugerenciaDevolucion: sugerenciasDevolucion[t.id] ?? null,
    })),
    pagination: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
    meses: mesesRaw.map((m) => ({ mes: m.mes, count: Number(m.n) })),
    statusCounts: {
      UNMATCHED: statusCounts.UNMATCHED ?? 0,
      MATCHED:   statusCounts.MATCHED   ?? 0,
      // Plain Ignorados = total IGNORED minus tagged subcategories
      IGNORED:   Math.max(0, (statusCounts.IGNORED ?? 0) - taggedTotal),
      ...subCounts,
      total:     (statusCounts.UNMATCHED ?? 0) + (statusCounts.MATCHED ?? 0) + (statusCounts.IGNORED ?? 0),
    },
  });
}

// PATCH /api/bancos/[id]  — editar datos de la cuenta (banco, nombre, número, CLABE)
export async function PATCH(req: Request, { params }: Params) {
  let user;
  try {
    user = await requireUser(req);
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const { id } = await params;
  const account = await prisma.bankAccount.findUnique({ where: { id } });
  if (!account) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(user.id, account.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  const { banco, nombre, numeroCuenta, clabe, moneda } = await req.json();
  const updated = await prisma.bankAccount.update({
    where: { id },
    data: {
      ...(banco !== undefined ? { banco } : {}),
      ...(nombre !== undefined ? { nombre } : {}),
      ...(numeroCuenta !== undefined ? { numeroCuenta } : {}),
      ...(clabe !== undefined ? { clabe: clabe || null } : {}),
      ...(moneda !== undefined ? { moneda } : {}),
    },
  });
  return NextResponse.json(updated);
}

// DELETE /api/bancos/[id]
// SOLO sesión web, a propósito: borrar una cuenta elimina en cascada TODOS sus
// movimientos. Los tokens de servicio (ZionX) espejan y concilian — no tienen
// por qué destruir; un token filtrado no debe poder borrar la historia bancaria.
export async function DELETE(_req: Request, { params }: Params) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id: bankAccountId } = await params;
  const account = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
  if (!account) return NextResponse.json({ error: "No encontrada" }, { status: 404 });

  const member = await getEffectiveCompanyMembership(session.user.id, account.companyId);
  if (!member || member.role === "VIEWER") return NextResponse.json({ error: "Sin permisos" }, { status: 403 });

  await prisma.bankAccount.delete({ where: { id: bankAccountId } });
  return NextResponse.json({ ok: true });
}
