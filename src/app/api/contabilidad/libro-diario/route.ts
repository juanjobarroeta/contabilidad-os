import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, withAuthz } from "@/lib/authz";
import { libroDiario, type EntryForLibro } from "@/lib/contabilidad/libro";

// GET /api/contabilidad/libro-diario?companyId=&year=&month= — pólizas del
// periodo agrupadas EXACTAMENTE como el XML del Anexo 24 (mismo folio).
// Sólo lectura — cualquier miembro.
export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const year = Number(searchParams.get("year"));
  const month = Number(searchParams.get("month"));
  if (!companyId || !year || !month) {
    return NextResponse.json({ error: "companyId, year y month requeridos" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);

  const entries = await prisma.accountingEntry.findMany({
    where: { companyId, year, month },
    select: {
      id: true, fecha: true, descripcion: true, monto: true, tipo: true,
      referencia: true, referenciaTipo: true, fuente: true,
      chartAccount: { select: { cuentaSAT: true, subcuenta: true, nombre: true } },
    },
    orderBy: { fecha: "asc" },
  });

  const forLibro: EntryForLibro[] = entries.map((e) => ({
    id: e.id,
    fecha: e.fecha.toISOString().slice(0, 10),
    concepto: e.descripcion,
    tipo: e.tipo,
    monto: e.monto,
    referencia: e.referencia,
    referenciaTipo: e.referenciaTipo,
    fuente: e.fuente,
    numCta: e.chartAccount.subcuenta ?? e.chartAccount.cuentaSAT,
    desCta: e.chartAccount.nombre,
  }));

  const polizas = libroDiario(forLibro);

  // Enlaces profundos: UUID de CFDI → id de Invoice (para abrir la factura).
  const uuids = [...new Set(polizas.filter((p) => p.referenciaTipo === "CFDI" && p.referencia).map((p) => p.referencia!))];
  const invoices = uuids.length
    ? await prisma.invoice.findMany({
        where: { companyId, uuid: { in: uuids } },
        select: { id: true, uuid: true },
      })
    : [];
  const invoiceIdPorUuid = Object.fromEntries(invoices.map((i) => [i.uuid, i.id]));

  return NextResponse.json({ polizas, invoiceIdPorUuid });
});
