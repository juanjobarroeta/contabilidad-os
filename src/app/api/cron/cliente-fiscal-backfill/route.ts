import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { parcheCliente, identidadDesdeCfdi, REGIMEN_PLACEHOLDER } from "@/lib/facturas/identidad-receptor";
import { parseCfdiXml } from "@/lib/sat-fiel";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/cliente-fiscal-backfill [?companyId=<id>][&limit=N]
//
// Completa el CP y el régimen de los clientes que ya están dados de alta,
// leyéndolos del XML de una factura que les EMITIMOS. Los importadores los
// creaban con régimen "616" y sin CP, así que facturarle a cualquiera de ellos
// exigía capturar los datos a mano — que es justo lo que no queremos.
//
// De dónde sale el dato: un CFDI 4.0 timbrado ya pasó la validación del padrón
// (RFC + Nombre + DomicilioFiscalReceptor), así que sus atributos SON los datos
// del cliente ante el SAT. Sólo se leen facturas EMITIDAS (ahí la contraparte
// es el receptor); en las recibidas el nodo Emisor no trae código postal.
//
// GAP-DRIVEN e idempotente: sólo toca clientes a los que les falta algo, y sólo
// escribe cuando el XML aporta. Nunca pisa un dato capturado a mano — el
// contador pudo corregirlo con la constancia enfrente.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LIMITE_DEFAULT = 300;
const TIME_BUDGET_MS = 240_000;

function autorizado(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  if (req.headers.get("authorization") === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!autorizado(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const companyId = url.searchParams.get("companyId");
  const limite = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "", 10) || LIMITE_DEFAULT, 1), 2000);
  const inicio = Date.now();

  // Clientes incompletos: sin CP o con el régimen de relleno.
  const incompletos = await prisma.customer.findMany({
    where: {
      ...(companyId ? { companyId } : {}),
      OR: [{ codigoPostal: null }, { regimenFiscal: REGIMEN_PLACEHOLDER }],
    },
    select: { id: true, companyId: true, rfc: true, codigoPostal: true, regimenFiscal: true },
    take: limite,
    orderBy: { createdAt: "asc" },
  });

  let actualizados = 0;
  let sinXml = 0;
  let sinDato = 0;

  for (const c of incompletos) {
    if (Date.now() - inicio > TIME_BUDGET_MS) break;

    // La factura emitida MÁS RECIENTE con XML: si el cliente cambió de
    // domicilio, la última es la que refleja su registro actual.
    const factura = await prisma.invoice.findFirst({
      where: {
        companyId: c.companyId,
        customerId: c.id,
        tipo: "INGRESO",
        status: { not: "CANCELLED" },
        rawXml: { not: null },
      },
      select: { rawXml: true },
      orderBy: { fecha: "desc" },
    });
    if (!factura?.rawXml) { sinXml++; continue; }

    let identidad;
    try {
      const cfdi = parseCfdiXml(factura.rawXml);
      // El RFC del receptor debe ser el del cliente; si no, el XML no es suyo.
      if ((cfdi.rfcReceptor ?? "").trim().toUpperCase() !== c.rfc.trim().toUpperCase()) { sinDato++; continue; }
      identidad = identidadDesdeCfdi(cfdi, true);
    } catch {
      sinDato++;
      continue;
    }

    const parche = parcheCliente(c, identidad);
    if (Object.keys(parche).length === 0) { sinDato++; continue; }

    await prisma.customer.update({ where: { id: c.id }, data: parche });
    actualizados++;
  }

  // Cuántos quedan: el ritmo adaptativo del scheduler lo usa para volver a
  // llamar en segundos mientras haya rezago, en vez de esperar su cadencia.
  const restantes = await prisma.customer.count({
    where: {
      ...(companyId ? { companyId } : {}),
      OR: [{ codigoPostal: null }, { regimenFiscal: REGIMEN_PLACEHOLDER }],
    },
  });

  const resumen = {
    ok: true,
    evaluados: incompletos.length,
    actualizados,
    // Sin factura emitida con XML: son proveedores o clientes a los que nunca
    // les hemos facturado. No hay de dónde sacarles el CP — no es una falla.
    sinXml,
    sinDato,
    restantes,
    elapsedMs: Date.now() - inicio,
  };
  console.log("[cron/cliente-fiscal-backfill] done:", JSON.stringify(resumen));
  return NextResponse.json(resumen);
}

export async function POST(req: Request) {
  return withCronLock("cron:cliente-fiscal-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:cliente-fiscal-backfill", () => handle(req));
}
