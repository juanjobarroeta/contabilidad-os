import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import {
  consultarEstadoCfdi,
  construirExpresion,
  datosConsultaDesdeXml,
  esCancelado,
} from "@/lib/fiscal/vigencia-cfdi";
import { revertirDerivadosDeCancelada } from "@/lib/automotriz/revertir-cancelada";
import {
  cupoPorEmpresa,
  empresasDelTurno,
  horasParaSiguienteTurno,
  inicioVentanaCancelable,
} from "@/lib/fiscal/vigencia-plan";

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
/** Cada cuánto vuelve a preguntarse por un UUID ya verificado. */
const DEFAULT_RECHECK_DAYS = 90;

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

  // Ventana de re-verificación. Sin ella el barrido NUNCA termina: el orden es
  // por vigenciaCheckedAt asc (nulls first) y no excluye lo ya verificado, así
  // que al acabar la primera pasada vuelve a empezar por la más vieja y
  // `candidatas` se queda pegada en el límite para siempre — quemando llamadas
  // al SAT en UUIDs que ya se preguntaron hoy.
  //
  // Una factura SÍ se puede cancelar después, así que re-verificar es correcto;
  // lo que faltaba era el «cada cuánto». Con la ventana, la primera pasada
  // termina de verdad (candidatas < limit) y la re-verificación entra sola
  // cuando el dato envejece.
  const recheckParam = parseInt(url.searchParams.get("recheckDays") ?? "", 10);
  const recheckDays = Number.isFinite(recheckParam) ? Math.max(recheckParam, 0) : DEFAULT_RECHECK_DAYS;
  const cutoff = new Date(Date.now() - recheckDays * 24 * 60 * 60 * 1000);

  const where: Prisma.InvoiceWhereInput = {
    ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
    status: "STAMPED",
    uuid: { not: null },
    tipo: { in: ["INGRESO", "EGRESO", "PAGO"] },
    fecha: { gte: desde },
    ...(soloExpediente ? { vehiculoMenciones: { some: {} } } : {}),
    // recheckDays=0 desactiva la ventana (re-verifica todo, como antes).
    //
    // La re-verificación se limita a lo que TODAVÍA puede cancelarse: por el
    // CFF desde 2022 un CFDI sólo es cancelable hasta la anual de su ejercicio,
    // así que una factura ya verificada y fuera de esa ventana no puede cambiar
    // nunca más — queda SELLADA. Sin esto, el pase histórico volvía a preguntar
    // por el archivo completo cada `recheckDays` para siempre: un costo
    // recurrente O(todas las facturas) que no escala. Con el sello, el trabajo
    // recurrente es O(ventana legal) y lo viejo se pregunta UNA vez.
    ...(recheckDays > 0
      ? {
          OR: [
            { vigenciaCheckedAt: null },
            { vigenciaCheckedAt: { lt: cutoff }, fecha: { gte: inicioVentanaCancelable(new Date()) } },
          ],
        }
      : {}),
  };

  // ── REPARTO JUSTO POR EMPRESA ────────────────────────────────────────────
  // Un cursor GLOBAL (tomar las `limit` más atrasadas del portafolio entero)
  // converge con pocas empresas, pero la espera de UNA empresa crece con el
  // número total de FACTURAS: la empresa con 136k CFDIs acapara cada corrida y
  // las demás se quedan sin turno (reporte real: 73% del portafolio verificado
  // y 0% de una empresa recién onboardeada). Con el reparto, cada corrida
  // atiende a las empresas de barrido más antiguo y a cada una le da una
  // rebanada del cupo, así la espera depende del número de EMPRESAS —acotada y
  // predecible— y no del tamaño del archivo de la más grande.
  const empresasPorCorrida = onlyCompanyId ? 1 : empresasDelTurno(limit);
  const empresas = await prisma.company.findMany({
    where: { isActive: true, ...(onlyCompanyId ? { id: onlyCompanyId } : {}) },
    // Nunca barridas primero: una empresa nueva entra al frente de la fila.
    orderBy: { vigenciaBarridoAt: { sort: "asc", nulls: "first" } },
    take: empresasPorCorrida,
    select: { id: true },
  });
  const cupo = cupoPorEmpresa(limit, empresas.length);

  const SELECT_CANDIDATA = {
    id: true,
    companyId: true,
    uuid: true,
    total: true,
    tipo: true,
    rawXml: true,
    company: { select: { rfc: true } },
    customer: { select: { rfc: true } },
  } as const;

  const invoices: Array<Prisma.InvoiceGetPayload<{ select: typeof SELECT_CANDIDATA }>> = [];
  for (const emp of empresas) {
    const suyas = await prisma.invoice.findMany({
      where: { ...where, companyId: emp.id },
      select: SELECT_CANDIDATA,
      orderBy: { vigenciaCheckedAt: { sort: "asc", nulls: "first" } },
      take: cupo,
    });
    invoices.push(...suyas);
  }

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

  const reversiones: Array<Record<string, unknown>> = [];
  if (cancelados.length > 0) {
    await prisma.invoice.updateMany({
      where: { id: { in: cancelados.map((c) => c.id) } },
      data: { status: "CANCELLED", canceladaAt: new Date() },
    });

    // Marcar la factura NO basta. El motor fiscal filtra por status al leer,
    // pero la capa de operación MATERIALIZA filas —unidades, costos, kardex,
    // órdenes, nómina— y ningún filtro deshace una fila escrita. Sin esto una
    // compra cancelada deja la unidad en el piso con su costo y una venta
    // cancelada la deja marcada vendida, con su precio contado como ingreso.
    //
    // Va después del updateMany y una por una: si una reversión falla, la
    // factura ya quedó CANCELLED (que es lo fiscalmente urgente) y el error se
    // reporta para reintentar, en vez de tirar el barrido entero.
    for (const c of cancelados) {
      try {
        const rev = await revertirDerivadosDeCancelada(prisma, c.id);
        if (rev.huboCambios) reversiones.push({ uuid: c.uuid, ...rev });
      } catch (e) {
        errores.push({
          uuid: c.uuid,
          error: `reversión falló: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }

  // Las empresas atendidas van al final de la fila: así rota el reparto.
  if (empresas.length > 0) {
    await prisma.company.updateMany({
      where: { id: { in: empresas.map((e) => e.id) } },
      data: { vigenciaBarridoAt: new Date() },
    });
  }

  // Cuánto falta DE VERDAD, para no confundir «sigue corriendo» con «avanza».
  const pendientes = await prisma.invoice.count({ where });
  const empresasTotales = onlyCompanyId
    ? 1
    : await prisma.company.count({ where: { isActive: true } });

  const summary = {
    ok: true,
    empresasAtendidas: empresas.length,
    cupoPorEmpresa: cupo,
    // Métrica de ESCALA: cuánto tarda una empresa en volver a tener turno. Es
    // lo que hay que vigilar al sumar clientes — si crece de más, se sube
    // limit, carriles o cadencia. No depende del tamaño del archivo.
    horasParaSiguienteTurno: horasParaSiguienteTurno({
      empresasTotales,
      empresasPorCorrida: empresas.length,
      corridasPorDia: 16, // dos cadencias en el scheduler: c/2 h y c/6 h
    }),
    candidatas: invoices.length,
    checked,
    skipped,
    pendientes,
    completado: pendientes === 0,
    desde: desde.toISOString().slice(0, 10),
    recheckDays,
    cancelados: cancelados.map((c) => c.uuid),
    // Lo que se deshizo en la capa de operación, para poder cuadrar el antes
    // con el después: sin esto una reversión es invisible.
    reversiones,
    errores,
    elapsedMs: Date.now() - startedAt,
    nota:
      pendientes === 0
        ? `Barrido completo del periodo desde ${desde.toISOString().slice(0, 10)}. Se re-verifica al cumplir ${recheckDays} días.`
        : `Faltan ${pendientes} por verificar desde ${desde.toISOString().slice(0, 10)}. Re-ejecuta hasta pendientes = 0.`,
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
