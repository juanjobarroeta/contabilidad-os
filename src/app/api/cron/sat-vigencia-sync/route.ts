import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import {
  consultarEstadoCfdi,
  construirExpresion,
  datosConsultaDesdeXml,
  esCancelado,
} from "@/lib/fiscal/vigencia-cfdi";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/sat-vigencia-sync   [?companyId=<id>][&limit=N][&desde=YYYY-MM-DD]
//
// Verifica la VIGENCIA de CFDIs STAMPED por UUID contra el servicio público del
// SAT y marca CANCELLED los que el SAT reporte cancelados. Es la red de
// seguridad del cancel-sync de descarga masiva: aquella vía sólo cubre una
// ventana de meses y consume cuota vitalicia (5002) — una factura cancelada
// fuera de ventana (caso real: emitida en enero, cancelada en marzo al
// re-emitirse) sobrevaluaba ingresos e IVA para siempre.
//
// Barrido incremental: primero las facturas nunca verificadas, luego las de
// verificación más antigua (cursor Invoice.vigenciaCheckedAt), acotado por
// `limit` por corrida (default 200) y con pausa entre llamadas para no golpear
// al SAT. Cubre INGRESO, EGRESO y PAGO (un REP cancelado cambia el IVA en
// flujo) del ejercicio en curso por default (`desde` lo mueve).
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_LIMIT = 200;
const PAUSA_MS = 150;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const onlyCompanyId = url.searchParams.get("companyId");
  const limitParam = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 500) : DEFAULT_LIMIT;
  const desdeParam = url.searchParams.get("desde");
  const desde = desdeParam
    ? new Date(`${desdeParam}T00:00:00Z`)
    : new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)); // ejercicio en curso
  const startedAt = Date.now();

  // expediente=1: prioriza los CFDIs que deciden la verdad del inventario —
  // los que están en el expediente de alguna unidad (compra, venta, duplicada,
  // sustituida…). Con refacturación sin cancelación sincronizada, la unidad
  // puede estar ligada a la factura MUERTA del par; verificar estos primeros
  // corrige precio/cliente/fecha de la venta con un barrido corto en vez de
  // recorrer todo el archivo.
  const soloExpediente = url.searchParams.get("expediente") === "1";

  const invoices = await prisma.invoice.findMany({
    where: {
      ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
      status: "STAMPED",
      uuid: { not: null },
      tipo: { in: ["INGRESO", "EGRESO", "PAGO"] },
      fecha: { gte: desde },
      ...(soloExpediente ? { vehiculoMenciones: { some: {} } } : {}),
    },
    select: {
      id: true,
      companyId: true,
      uuid: true,
      total: true,
      tipo: true,
      rawXml: true,
      company: { select: { rfc: true } },
      customer: { select: { rfc: true } },
    },
    orderBy: { vigenciaCheckedAt: { sort: "asc", nulls: "first" } },
    take: limit,
  });

  let checked = 0;
  let skipped = 0;
  const cancelados: { id: string; uuid: string; companyId: string }[] = [];
  const errores: { uuid: string; error: string }[] = [];

  // Consultas en paralelo acotado: la latencia del servicio del SAT (~300 ms)
  // dominaba la corrida en serie, así que una empresa recién onboardeada
  // tardaba SEMANAS en verificar su archivo (136k CFDIs a ~500 por tick). Con
  // un pool chico el rendimiento sube ~4x sin volverse agresivo: se mantiene la
  // pausa entre llamadas DENTRO de cada carril, así que el ritmo hacia el SAT
  // sigue siendo modesto y predecible.
  const CARRILES = 4;
  const carril = async (desde: number): Promise<void> => {
    for (let i = desde; i < invoices.length; i += CARRILES) {
      const inv = invoices[i];
      // Datos de la expresión: del rawXml (Total VERBATIM, la comparación del
      // SAT es textual) o, para emitidas sin XML guardado, del par
      // empresa/cliente.
      const datos = inv.rawXml
        ? datosConsultaDesdeXml(inv.rawXml, inv.uuid!)
        : inv.tipo === "INGRESO" && inv.customer?.rfc
          ? { re: inv.company.rfc, rr: inv.customer.rfc, tt: inv.total.toFixed(2), id: inv.uuid! }
          : null;
      if (!datos) {
        // Sin datos para consultar (p. ej. recibida legacy sin XML). También
        // avanza el cursor: si no, estas facturas se quedan clavadas al frente
        // del orden (vigenciaCheckedAt null) y cada pasada las re-evalúa,
        // desperdiciando cupo del `limit` (visto en producción: 140+ saltadas
        // por pasada). Cuando el backfill les consiga el rawXml, la rotación
        // normal del cursor las vuelve a intentar.
        skipped++;
        await prisma.invoice.update({
          where: { id: inv.id },
          data: { vigenciaCheckedAt: new Date() },
        });
        continue;
      }

      try {
        const estado = await consultarEstadoCfdi(construirExpresion(datos));
        checked++;
        if (estado && esCancelado(estado)) {
          cancelados.push({ id: inv.id, uuid: inv.uuid!, companyId: inv.companyId });
        }
        // "No Encontrado" o respuesta rara: NO se toca la factura (conservador)
        // — sólo avanza el cursor para que el barrido no se atore en ella.
        await prisma.invoice.update({
          where: { id: inv.id },
          data: { vigenciaCheckedAt: new Date() },
        });
      } catch (e) {
        errores.push({ uuid: inv.uuid!, error: e instanceof Error ? e.message : String(e) });
      }
      await sleep(PAUSA_MS);
    }
  };
  await Promise.all(Array.from({ length: CARRILES }, (_, k) => carril(k)));

  if (cancelados.length > 0) {
    await prisma.invoice.updateMany({
      where: { id: { in: cancelados.map((c) => c.id) } },
      data: { status: "CANCELLED", canceladaAt: new Date() },
    });
  }

  const summary = {
    ok: true,
    candidatas: invoices.length,
    checked,
    skipped,
    cancelados: cancelados.map((c) => c.uuid),
    errores,
    elapsedMs: Date.now() - startedAt,
    nota: "Barrido incremental por vigenciaCheckedAt: re-ejecuta hasta que candidatas < limit para cubrir todo.",
  };
  console.log("[cron/sat-vigencia-sync] done:", JSON.stringify({ ...summary, cancelados: cancelados.length }));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:sat-vigencia-sync", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:sat-vigencia-sync", () => handle(req));
}
