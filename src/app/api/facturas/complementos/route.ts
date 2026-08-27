import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { AuthzError, getEffectiveCompanyMembership, requireUser } from "@/lib/authz";
import { resumenRep } from "@/lib/facturas/complementos-vista";
import { normalizarUuid, variantesUuid } from "@/lib/fiscal/uuid";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/facturas/complementos?companyId=&dir=emitidos|recibidos
//        [&take=50&skip=0][&from=ISO&to=ISO]
//
// La vista de complementos de pago, separada por dirección. Un REP es tipo
// PAGO en ambos sentidos y el comprobante no dice cuál es: la dirección se
// deriva de las facturas que paga — INGRESO nuestro ⇒ lo emitimos; EGRESO de un
// proveedor ⇒ lo recibimos. Mismo criterio que la DIOT y el motor de IVA.
//
// La clasificación va en SQL (EXISTS) para poder FILTRAR Y PAGINAR por
// dirección sin traer todo a memoria. El `IN (uuid, UPPER, LOWER)` es
// `variantesUuid` en SQL: los UUID se guardan con la caja con la que llegaron,
// y un UPPER(col) en el JOIN tiraría el índice.
//
// Los REPs cuyas facturas no están en el sistema no caen en ningún lado; el
// conteo `sinClasificar` los declara en vez de esconderlos.
// ─────────────────────────────────────────────────────────────────────────────

const TAKE_DEFAULT = 50;
const TAKE_MAX = 200;

export async function GET(req: Request) {
  let userId: string;
  try {
    const u = await requireUser(req);
    userId = u.id;
  } catch (e) {
    const status = e instanceof AuthzError ? e.status : 401;
    return NextResponse.json({ error: "Unauthorized" }, { status });
  }

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  const dir = searchParams.get("dir") === "recibidos" ? "recibidos" : "emitidos";
  const take = Math.min(Math.max(parseInt(searchParams.get("take") ?? "", 10) || TAKE_DEFAULT, 1), TAKE_MAX);
  const skip = Math.max(parseInt(searchParams.get("skip") ?? "", 10) || 0, 0);
  const from = searchParams.get("from");
  const to = searchParams.get("to");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(userId, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const tipoPadre = dir === "emitidos" ? "INGRESO" : "EGRESO";
  const rangoFecha =
    from && to
      ? Prisma.sql`AND i."fecha" >= ${new Date(from)} AND i."fecha" < ${new Date(to)}`
      : Prisma.empty;

  /** EXISTS de un docto cuyo padre (por UUID, caja-insensible vía variantes) es del tipo dado. */
  const existePadre = (tipo: string) => Prisma.sql`
    EXISTS (
      SELECT 1
      FROM "PagoDoctoRelacionado" d
      JOIN "Invoice" p
        ON p."companyId" = i."companyId"
       AND p."uuid" IN (d."parentUuid", UPPER(d."parentUuid"), LOWER(d."parentUuid"))
       AND p."tipo" = ${tipo}::"InvoiceType"
      WHERE d."pagoInvoiceId" = i."id"
    )`;

  const [pagina, conteos] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT i."id"
      FROM "Invoice" i
      WHERE i."companyId" = ${companyId}
        AND i."tipo" = 'PAGO'
        AND i."status" <> 'CANCELLED'
        ${rangoFecha}
        AND ${existePadre(tipoPadre)}
      ORDER BY i."fecha" DESC, i."id" DESC
      LIMIT ${take} OFFSET ${skip}`,
    prisma.$queryRaw<Array<{ emitidos: bigint; recibidos: bigint; total: bigint }>>`
      SELECT
        count(*) FILTER (WHERE ${existePadre("INGRESO")}) AS emitidos,
        count(*) FILTER (WHERE ${existePadre("EGRESO")}) AS recibidos,
        count(*) AS total
      FROM "Invoice" i
      WHERE i."companyId" = ${companyId}
        AND i."tipo" = 'PAGO'
        AND i."status" <> 'CANCELLED'
        ${rangoFecha}`,
  ]);

  // Hidratación por ids (página chica — sin riesgo de tope de parámetros).
  const ids = pagina.map((r) => r.id);
  const filas = ids.length
    ? await prisma.invoice.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          companyId: true,
          uuid: true,
          fecha: true,
          tipo: true,
          metodoPago: true,
          status: true,
          subtotal: true,
          total: true,
          totalImpuestos: true,
          notas: true,
          facturapiId: true,
          naturaleza: true,
          naturalezaRevision: true,
          regimenNomina: true,
          isrRetenidoNomina: true,
          contraparteNombre: true,
          contraparteRfc: true,
          customer: { select: { razonSocial: true, rfc: true } },
          doctosRelacionados: {
            select: {
              parentUuid: true,
              impPagado: true,
              ivaTrasladado: true,
              fechaPago: true,
              numParcialidad: true,
            },
          },
        },
      })
    : [];

  // Facturas pagadas de la página, para el enlace "paga a F-123".
  const parentUuids = [...new Set(filas.flatMap((f) => f.doctosRelacionados.map((d) => d.parentUuid)))];
  const padres = parentUuids.length
    ? await prisma.invoice.findMany({
        where: { companyId, uuid: { in: variantesUuid(parentUuids) } },
        select: { id: true, uuid: true, total: true, fecha: true, customer: { select: { razonSocial: true } } },
      })
    : [];
  const padrePorUuid = new Map(padres.map((p) => [normalizarUuid(p.uuid ?? ""), p]));

  const porId = new Map(filas.map((f) => [f.id, f]));
  const rows = ids
    .map((id) => porId.get(id))
    .filter((f): f is NonNullable<typeof f> => !!f)
    .map((f) => {
      const { doctosRelacionados: doctosRaw, ...rest } = f;
      const doctosRelacionados = doctosRaw.map((d) => ({
        ...d,
        impPagado: d.impPagado === null ? null : Number(d.impPagado),
        ivaTrasladado: d.ivaTrasladado === null ? null : Number(d.ivaTrasladado),
      }));
      const r = resumenRep(doctosRelacionados);
      return {
        ...rest,
        pagoMonto: r.monto,
        pagoIva: r.iva,
        pagoFecha: r.fechaPago,
        parcialidades: r.parcialidades,
        paga: doctosRelacionados.map((d) => {
          const padre = padrePorUuid.get(normalizarUuid(d.parentUuid));
          return {
            invoiceId: padre?.id ?? null,
            uuid: d.parentUuid,
            cliente: padre?.customer?.razonSocial ?? null,
            totalFactura: padre?.total ?? null,
            montoPagado: d.impPagado,
            numParcialidad: d.numParcialidad,
          };
        }),
      };
    });

  const c = conteos[0];
  const emitidos = Number(c?.emitidos ?? 0);
  const recibidos = Number(c?.recibidos ?? 0);
  const total = Number(c?.total ?? 0);

  return NextResponse.json({
    rows,
    conteos: {
      emitidos,
      recibidos,
      // Sin factura relacionada en el sistema: se declara, no se esconde.
      sinClasificar: Math.max(0, total - emitidos - recibidos),
    },
    hayMas: pagina.length === take,
  });
}
