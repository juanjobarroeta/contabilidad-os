import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, withAuthz } from "@/lib/authz";
import { auxiliarCuenta, type EntryForLibro } from "@/lib/contabilidad/libro";
import { balanza } from "@/lib/contabilidad/posting";
import { clavePeriodo, hojaAuxiliar } from "@/lib/contabilidad/reportes-xlsx";
import { headersDescargaXlsx, toXlsx } from "@/lib/export/xlsx";

// GET /api/contabilidad/auxiliar?companyId=&year=&month=&cuenta=102.01 —
// movimientos de UNA cuenta en el periodo con saldo corrido (drill-down de la
// balanza). El saldo inicial viene de la propia balanza (acumulado previo).
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = Number(searchParams.get("year"));
  const month = Number(searchParams.get("month"));
  const cuenta = searchParams.get("cuenta");
  if (!companyId || !year || !month || !cuenta) {
    return NextResponse.json({ error: "companyId, year, month y cuenta requeridos" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);

  const account = await prisma.chartAccount.findFirst({
    where: { companyId, OR: [{ subcuenta: cuenta }, { cuentaSAT: cuenta, subcuenta: null }] },
    select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true, tipo: true },
  });
  if (!account) return NextResponse.json({ error: `Cuenta ${cuenta} no encontrada` }, { status: 404 });

  const [entries, rows] = await Promise.all([
    prisma.accountingEntry.findMany({
      where: { companyId, year, month, chartAccountId: account.id },
      select: {
        id: true, fecha: true, descripcion: true, monto: true, tipo: true,
        referencia: true, referenciaTipo: true, fuente: true,
      },
      orderBy: { fecha: "asc" },
    }),
    balanza(companyId, year, month),
  ]);

  const balRow = rows.find((r) => (r.subcuenta ?? r.cuentaSAT) === (account.subcuenta ?? account.cuentaSAT));

  const forLibro: EntryForLibro[] = entries.map((e) => ({
    id: e.id,
    fecha: e.fecha.toISOString().slice(0, 10),
    concepto: e.descripcion,
    tipo: e.tipo,
    monto: Number(e.monto),
    referencia: e.referencia,
    referenciaTipo: e.referenciaTipo,
    fuente: e.fuente,
    numCta: account.subcuenta ?? account.cuentaSAT,
    desCta: account.nombre,
  }));

  const aux = auxiliarCuenta(forLibro, balRow?.saldoInicial ?? 0);
  const numCta = account.subcuenta ?? account.cuentaSAT;

  if (searchParams.get("format") === "xlsx") {
    return new NextResponse(new Uint8Array(toXlsx([hojaAuxiliar(aux, numCta, account.nombre)])), {
      headers: headersDescargaXlsx(`Auxiliar ${numCta} ${clavePeriodo(year, month)}.xlsx`),
    });
  }

  const uuids = [...new Set(aux.movimientos.filter((m) => m.referenciaTipo === "CFDI" && m.referencia).map((m) => m.referencia!))];
  const invoices = uuids.length
    ? await prisma.invoice.findMany({ where: { companyId, uuid: { in: uuids } }, select: { id: true, uuid: true } })
    : [];
  const invoiceIdPorUuid = Object.fromEntries(invoices.map((i) => [i.uuid, i.id]));

  return NextResponse.json({
    cuenta: account.subcuenta ?? account.cuentaSAT,
    nombre: account.nombre,
    tipo: account.tipo,
    ...aux,
    invoiceIdPorUuid,
  });
});
