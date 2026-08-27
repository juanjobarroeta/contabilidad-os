import { NextResponse } from "next/server";
import type { ModuloApp } from "@prisma/client";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { derivarServicioDesdeCfdiSiAplica, extraerServicioCfdi } from "@/lib/automotriz/auto-servicio";
import { extraerDatosVehiculoCfdi, tipoComprobanteDesdeCfdi } from "@/lib/automotriz/vin";
import {
  empresasPendientes,
  guardarProgreso,
  leerProgreso,
  reiniciarProgreso,
} from "@/lib/automotriz/backfill-progreso";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/servicio-backfill?companyId=…[&afterId=…]
//
// Drenado histórico de las VENTAS DE SERVICIO/TALLER: recorre los CFDIs de
// ingreso y deriva ServicioVenta (mano de obra vs refacciones, cliente, VIN).
// Cursor afterId → nextAfterId (null = terminó); hacia adelante la derivación
// inline mantiene el histórico al día.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los demás crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PAGE = 200;
const TIME_BUDGET_MS = 240_000;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const onlyCompanyId = url.searchParams.get("companyId");
  // diagnostico=1: NO escribe nada. Clasifica por qué cada CFDI de la cola no
  // deriva servicio (unidad amparada, nota de crédito, sin línea de servicio…)
  // con ejemplos de UUID por causa. Es la herramienta para cuando el drenado
  // reporta 0 derivadas sobre miles de candidatas: dice dónde se van.
  const diagnostico = url.searchParams.get("diagnostico") === "1";
  // reiniciar=1: vuelve a barrer desde cero (tras cambiar reglas de extracción).
  const reiniciar = url.searchParams.get("reiniciar") === "1";
  // recalcular=1: BORRA lo ya derivado antes de volver a barrer.
  //
  // `reiniciar` sólo mueve el cursor, y el barrido filtra `servicioVenta: null`
  // — así que una factura ya derivada NUNCA se vuelve a mirar por más veces que
  // se reinicie. En Margom eso devolvió «derivadas: 0» en 5 segundos sobre
  // 38,996 órdenes que arrastraban el defecto de los anticipos: el arreglo del
  // extractor estaba desplegado y no tocaba un solo renglón viejo.
  //
  // Para que un cambio en las reglas de extracción alcance a los datos viejos
  // hay que borrarlos. Exige companyId explícito: es destructivo y no debe
  // caerle a la empresa que el cron eligió solo.
  const recalcular = url.searchParams.get("recalcular") === "1";
  if (recalcular && !onlyCompanyId) {
    return NextResponse.json(
      { error: "recalcular=1 requiere companyId explícito (borra las ventas de servicio derivadas)" },
      { status: 400 }
    );
  }
  const startedAt = Date.now();

  // Sin companyId explícito, el cron elige solo a quién le falta carga inicial:
  // así una empresa que sube su e.firma el viernes termina de cargar sola.
  const objetivo =
    onlyCompanyId ?? (diagnostico ? null : (await empresasPendientes(prisma, "servicio", 1))[0] ?? null);
  // El progreso se LEE antes de decidir si se reinicia: `recalcular` que cae a
  // mitad de un barrido debe CONTINUARLO, no empezarlo de cero.
  //
  // Sin esto no había forma de terminar un recalcular. Con la bandera, el
  // cursor volvía al principio en cada ronda (bucle infinito); sin ella, el
  // barrido cambiaba de semántica a media corrida y saltaba justo lo que
  // faltaba por rehacer — y reportaba «completado: true». Visto en producción:
  // 66,200 escaneadas con completado:false, y la siguiente ronda sin bandera
  // cerró el barrido con «derivadas: 0» dejando la cola con datos viejos.
  const previo = objetivo && !diagnostico ? await leerProgreso(prisma, objetivo, "servicio") : null;
  const continuandoRecalculo = recalcular && previo != null && !previo.completado;
  if (objetivo && (reiniciar || (recalcular && !continuandoRecalculo))) {
    await reiniciarProgreso(prisma, objetivo, "servicio");
  }

  // El borrado va POR PÁGINA, no de golpe al principio: si se borran las 38,996
  // ventas de servicio antes de empezar, el taller reporta cero durante toda la
  // re-derivación y la pantalla no dice que el dato está a medio reconstruir.
  // Un tablero a medias miente peor que uno viejo, porque parece terminado.
  //
  // Borrar deja `OrdenServicio.servicioVentaId` en null (onDelete: SetNull) y la
  // re-derivación vuelve a ligar la orden con su nueva venta, así que el taller
  // no pierde el vínculo con su documento operativo.
  let borradas = 0;

  const where = {
    tipo: "INGRESO" as const,
    status: { not: "CANCELLED" as const },
    rawXml: { not: null },
    // Al recalcular hay que MIRAR las que ya derivaron — son justamente las que
    // se van a rehacer. Con el filtro puesto, el barrido las excluiría y el
    // borrado por página no tendría nada que rederivar.
    ...(recalcular ? {} : { servicioVenta: null }),
    company: { modules: { some: { modulo: "AUTOMOTRIZ" as ModuloApp, habilitado: true } } },
    ...(objetivo ? { companyId: objetivo } : {}),
  };

  // El cursor viene del parámetro (operación manual) o de la base (automático).
  const guardado = continuandoRecalculo ? previo : (objetivo && !diagnostico ? await leerProgreso(prisma, objetivo, "servicio") : null);
  let lastId: string | undefined =
    url.searchParams.get("afterId") ?? (guardado && !guardado.completado ? (guardado.cursor ?? undefined) : undefined);
  let barridoCompleto = true;
  let scanned = 0;
  let derivadas = 0;
  const razones: Record<string, number> = {};
  const ejemplos: Record<string, string[]> = {};

  while (true) {
    if (Date.now() - startedAt >= TIME_BUDGET_MS) {
      barridoCompleto = false;
      break;
    }
    const page = await prisma.invoice.findMany({
      where: { ...where, ...(lastId ? { id: { gt: lastId } } : {}) },
      select: { id: true, companyId: true, tipo: true, fecha: true, total: true, rawXml: true, customerId: true, uuid: true },
      orderBy: { id: "asc" },
      take: PAGE,
    });
    if (page.length === 0) break;

    if (recalcular && !diagnostico) {
      borradas += (
        await prisma.servicioVenta.deleteMany({ where: { invoiceId: { in: page.map((p) => p.id) } } })
      ).count;
    }

    for (const inv of page) {
      scanned++;
      if (diagnostico) {
        clasificar(inv.rawXml, inv.uuid ?? inv.id, razones, ejemplos);
        continue;
      }
      const creo = await derivarServicioDesdeCfdiSiAplica(prisma, {
        companyId: inv.companyId,
        invoiceId: inv.id,
        tipo: inv.tipo,
        fecha: inv.fecha,
        total: Number(inv.total),
        rawXml: inv.rawXml,
        clienteId: inv.customerId,
      });
      if (creo) derivadas++;
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }

  // Progreso durable: la próxima corrida (cron o manual) retoma sin que nadie
  // tenga que acordarse del cursor.
  if (objetivo && !diagnostico) {
    await guardarProgreso(prisma, objetivo, "servicio", {
      cursor: lastId ?? null,
      procesados: scanned,
      derivados: derivadas,
      completado: barridoCompleto,
    });
  }

  const summary = {
    ok: true,
    companyId: objetivo,
    scanned,
    derivadas,
    ...(recalcular ? { borradas } : {}),
    completado: barridoCompleto,
    ...(diagnostico ? { diagnostico: true, razones, ejemplos } : {}),
    nextAfterId: !barridoCompleto ? (lastId ?? null) : null,
    elapsedMs: Date.now() - startedAt,
  };
  console.log("[cron/servicio-backfill] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

/** Clasifica por qué un CFDI de la cola no deriva servicio (sólo diagnóstico). */
function clasificar(
  rawXml: string | null,
  ref: string,
  razones: Record<string, number>,
  ejemplos: Record<string, string[]>
): void {
  const marcar = (razon: string) => {
    razones[razon] = (razones[razon] ?? 0) + 1;
    const lista = (ejemplos[razon] ??= []);
    if (lista.length < 3) lista.push(ref);
  };
  if (!rawXml) return marcar("sinRawXml");
  if (tipoComprobanteDesdeCfdi(rawXml) === "E") return marcar("notaCredito");
  const unidades = extraerDatosVehiculoCfdi(rawXml).vehiculos.length;
  if (unidades > 0) return marcar("amparaUnidad");
  const datos = extraerServicioCfdi(rawXml);
  if (!datos.esServicio) {
    return marcar(datos.refacciones > 0 ? "soloRefacciones" : "sinLineaDeServicio");
  }
  marcar("derivable");
}

export async function POST(req: Request) {
  return withCronLock("cron:servicio-backfill", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:servicio-backfill", () => handle(req));
}
