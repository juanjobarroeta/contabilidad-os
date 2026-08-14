import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import {
  canceladasConEfectosVivos,
  revertirDerivadosDeCancelada,
} from "@/lib/automotriz/revertir-cancelada";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/revertir-canceladas?companyId=<id>[&limit=N][&dryRun=1]
//
// Deuda histórica: cancelar un CFDI sólo cambiaba `Invoice.status`, y la capa de
// operación materializa filas que ningún filtro por status deshace. En MARGOM
// quedaron 3,695 CFDIs de ingreso cancelados y 4 de egreso con todo su efecto
// vivo — unidades en el piso con costo de una compra cancelada, unidades
// marcadas vendidas contra una factura muerta.
//
// De aquí en adelante lo previenen sat-vigencia-sync (consulta por UUID, sin
// cuota) y el cancel-sync de metadata, que ya llaman a la reversión al detectar.
// Este barrido limpia lo que quedó de antes.
//
// `dryRun=1` reporta sin escribir: conviene verlo antes de mover inventario.
// Idempotente: una factura ya revertida no vuelve a aparecer.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2_000;
const TIME_BUDGET_MS = 240_000;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const companyId = params.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  const dryRun = params.get("dryRun") === "1";
  const limitParam = parseInt(params.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(limitParam, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const startedAt = Date.now();

  const candidatas = await canceladasConEfectosVivos(prisma, companyId, limit);

  const totales = {
    unidadesDescompradas: 0,
    /** De las descompradas, las que además salen de piso (nunca se vendieron). */
    unidadesRetiradas: 0,
    costoLiberado: 0,
    unidadesDevueltasAPiso: 0,
    ingresoLiberado: 0,
    costosBorrados: 0,
    montoCostosBorrados: 0,
    costosManualesConservados: 0,
    movimientosRefaccion: 0,
    servicios: 0,
    nomina: 0,
  };
  const detalle: Array<Record<string, unknown>> = [];
  const errores: Array<{ invoiceId: string; error: string }> = [];
  let procesadas = 0;

  for (const invoiceId of candidatas) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    procesadas++;
    if (dryRun) {
      // En seco no se llama a la reversión (escribe): sólo se reporta que la
      // factura tiene efectos vivos, que es lo que decide si vale la pena.
      detalle.push({ invoiceId, dryRun: true });
      continue;
    }
    try {
      const rev = await revertirDerivadosDeCancelada(prisma, invoiceId);
      if (!rev.huboCambios) continue;
      totales.unidadesDescompradas += rev.compras.unidades;
      totales.unidadesRetiradas += rev.compras.retiradas;
      totales.costoLiberado = r2(totales.costoLiberado + rev.compras.costoLiberado);
      totales.unidadesDevueltasAPiso += rev.ventas.unidades;
      totales.ingresoLiberado = r2(totales.ingresoLiberado + rev.ventas.ingresoLiberado);
      totales.costosBorrados += rev.costos.borrados;
      totales.montoCostosBorrados = r2(totales.montoCostosBorrados + rev.costos.monto);
      totales.costosManualesConservados += rev.costos.conservadosManuales;
      totales.movimientosRefaccion += rev.refacciones.movimientos;
      totales.servicios += rev.servicios.borrados;
      totales.nomina += rev.nomina.borrados;
      // Sólo las 25 más ruidosas: el resumen es lo que se audita, no la lista.
      // `rev` ya trae invoiceId.
      if (detalle.length < 25) detalle.push({ ...rev });
    } catch (e) {
      errores.push({ invoiceId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const restantes = dryRun
    ? candidatas.length
    : (await canceladasConEfectosVivos(prisma, companyId, MAX_LIMIT)).length;

  const summary = {
    ok: true,
    companyId,
    dryRun,
    candidatas: candidatas.length,
    procesadas,
    totales,
    restantes,
    errores,
    elapsedMs: Date.now() - startedAt,
    nota:
      "Re-ejecutable: `restantes` converge a 0. Una unidad cuya COMPRA se canceló " +
      "NO se borra — pierde costo y liga, y si fue refacturación el CFDI nuevo la " +
      "vuelve a derivar. Los costos capturados a mano se conservan.",
  };
  console.log("[cron/revertir-canceladas]", JSON.stringify({ ...summary, detalle: undefined }));
  return NextResponse.json({ ...summary, detalle });
}

export async function POST(req: Request) {
  return withCronLock("cron:revertir-canceladas", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:revertir-canceladas", () => handle(req));
}
