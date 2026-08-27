import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, withAuthz } from "@/lib/authz";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/contabilidad/cuenta-documentos?companyId=…&cuenta=4101-0001-0000
//                                        &anio=2026&mes=6[&ytd=1][&limit=200]
//
// El último escalón del drill: de una cuenta del estado de resultados a los
// DOCUMENTOS que la forman. Cada renglón trae su CFDI —folio fiscal, serie,
// contraparte, importe— para que se pueda abrir la representación impresa
// (/api/facturas/[id]/representacion, que la arma del XML guardado porque la
// descarga masiva no trae PDF) y para que la contraparte sea navegable.
//
// El recibo de nómina llega por aquí igual que una factura: es un CFDI, y su
// asiento lo referencia por UUID como cualquier otro.
//
// Los asientos sin comprobante (banco, depreciación, ajustes manuales) también
// se devuelven, con `invoice: null` y su descripción — esconderlos haría que la
// suma de los documentos no cuadre contra el renglón, que es justo lo que el
// contador va a verificar.
// ─────────────────────────────────────────────────────────────────────────────
const LIMITE_DEFAULT = 200;

export const GET = withAuthz(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const cuenta = searchParams.get("cuenta");
  if (!companyId || !cuenta) {
    return NextResponse.json({ error: "companyId y cuenta requeridos" }, { status: 400 });
  }
  await requireMembership(companyId, undefined, req);

  const anio = Number(searchParams.get("anio"));
  const mes = Number(searchParams.get("mes"));
  if (!Number.isInteger(anio) || !Number.isInteger(mes) || mes < 1 || mes > 12) {
    return NextResponse.json({ error: "anio y mes requeridos" }, { status: 400 });
  }
  const desdeMes = searchParams.get("ytd") === "1" ? 1 : mes;
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || LIMITE_DEFAULT, 1), 1000);

  // Mismo criterio que el estado de resultados: sin apertura ni cierre, para
  // que la suma de los documentos cuadre contra el renglón que se abrió.
  const where: Prisma.AccountingEntryWhereInput = {
    companyId,
    year: anio,
    month: { gte: desdeMes, lte: mes },
    chartAccount: { cuentaSAT: cuenta },
    fuente: { notIn: ["APERTURA", "CIERRE"] },
  };

  const [total, agregado, asientos] = await Promise.all([
    prisma.accountingEntry.count({ where }),
    prisma.accountingEntry.groupBy({ by: ["tipo"], where, _sum: { monto: true } }),
    prisma.accountingEntry.findMany({
      where,
      orderBy: [{ fecha: "desc" }, { monto: "desc" }],
      take: limit,
      select: {
        id: true, fecha: true, descripcion: true, monto: true, tipo: true,
        fuente: true, referencia: true, referenciaTipo: true,
      },
    }),
  ]);

  const abonos = Number(agregado.find((a) => a.tipo === "ABONO")?._sum.monto ?? 0);
  const cargos = Number(agregado.find((a) => a.tipo === "CARGO")?._sum.monto ?? 0);

  const uuids = [
    ...new Set(
      asientos.filter((a) => a.referenciaTipo === "CFDI" && a.referencia).map((a) => a.referencia!),
    ),
  ];
  const facturas = uuids.length
    ? await prisma.invoice.findMany({
        where: { companyId, uuid: { in: uuids } },
        select: {
          id: true, uuid: true, serie: true, folio: true, fecha: true, tipo: true, tipoSat: true,
          subtotal: true, total: true, contraparteRfc: true, contraparteNombre: true,
          customerId: true, rawXml: true,
        },
      })
    : [];
  const porUuid = new Map(
    facturas.map((f) => [
      f.uuid!,
      {
        id: f.id,
        uuid: f.uuid,
        serie: f.serie,
        folio: f.folio,
        fecha: f.fecha,
        tipo: f.tipo,
        tipoSat: f.tipoSat,
        subtotal: f.subtotal,
        total: f.total,
        contraparteRfc: f.contraparteRfc,
        contraparteNombre: f.contraparteNombre,
        customerId: f.customerId,
        /** Hay XML guardado, así que la representación impresa se puede armar. */
        representable: f.rawXml != null,
      },
    ]),
  );

  return NextResponse.json({
    cuenta,
    anio,
    mes,
    total,
    mostrados: asientos.length,
    cargos,
    abonos,
    // Mismo signo que el estado de resultados: aporte al resultado.
    neto: Math.round((abonos - cargos) * 100) / 100,
    documentos: asientos.map((a) => ({
      id: a.id,
      fecha: a.fecha,
      descripcion: a.descripcion,
      monto: a.tipo === "ABONO" ? a.monto : -a.monto,
      tipo: a.tipo,
      fuente: a.fuente,
      invoice: a.referenciaTipo === "CFDI" && a.referencia ? (porUuid.get(a.referencia) ?? null) : null,
    })),
  });
});
