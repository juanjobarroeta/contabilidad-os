import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { submitSatSync, syncCancelacionesPeriodo, verifyAndImportSatSync } from "@/lib/sat-sync";
import { partirMes, etiquetaTramo } from "@/lib/sat-tramos";
import { parsePeriodos } from "./parse-periodos";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/sat-repesca?companyId=<id>&periodos=YYYY-MM,YYYY-MM[&dryRun=1]
//
// Vuelve a pedirle al SAT los CFDIs de periodos ESPECÍFICOS. Existe porque
// sat-backfill no puede: salta cualquier mes ya marcado hecho
// (`if (done.has(...)) continue`), y `finishedPeriods` lo marca hecho cuando las
// dos solicitudes llegan a FINISHED — SIN IMPORTAR cuántas facturas entraron.
//
// Yo creí que eran ocho meses de MARGOM, comparando cada mes contra sus vecinos.
// El dato del propio SAT (cfdisFound, ver /api/cron/sat-cobertura) dice que son
// DOS, y que seis de aquellos ocho tienen lo que el SAT dice que existe:
//
//   2025-04   SAT 4,453   tenemos 1,725   38.7%   faltan 2,728
//   2024-01   SAT 2,690   tenemos    57    2.1%   faltan 2,633
//
// 5,361 facturas. Comparar contra los vecinos era una corazonada; el conteo del
// SAT es el dato. Saca la lista de `sat-cobertura` (campo `paraRepescar`), no a
// ojo: cada periodo inventado quema cuota vitalicia.
//
// AVISO DE CUOTA (5002). El SAT limita las solicitudes DE POR VIDA por
// (RFC + rango + tipo), y esperar NO la libera. `force` salta el reúso de 24h
// pero no la cuota vitalicia.
//
// MEDIDO el 2026-08-14 con MARGOM 2025-04: el mes completo devuelve 5002 en
// emitidos Y en recibidos. La vía mensual está muerta para estos periodos.
//
// De ahí `tramos=N`: parte el mes en N rangos contiguos. La cuota se cuenta por
// RANGO, así que un tramo es otra llave — es lo que el propio mensaje del SAT
// sugiere («pide un rango de fechas distinto»). Cuesta 2 solicitudes por tramo
// (emitidos + recibidos), así que tramos=2 son 4 y tramos=31 son 62. Empieza
// con tramos=2 y sube sólo si vuelve a salir 5002.
//
// Con más de un tramo NO se fuerza el reúso: la solicitud queda guardada con su
// `desde`/`hasta`, así que una segunda corrida reutiliza el MISMO tramo en vez
// de quemar cuota otra vez. Si aun con tramos sale 5002 en todos los rangos,
// queda Syntage, cuyo cliente ya tiene el extractor "invoice".
//
// Un tramo quemado NO detiene los demás: la cuota es por rango, así que lo que
// falle en 04-01→04-15 no dice nada de 04-16→04-30.
//
// `saltarTramos=N` salta los primeros N tramos del mes. Hace falta porque un
// tramo YA COMPLETO se sigue re-verificando —descarga su paquete aunque importe
// 0 por dedup— y se come el presupuesto, dejando al siguiente en `pendiente`
// corrida tras corrida. Medido en 2024-01: el tramo 1 terminado bloqueaba al 2
// indefinidamente. Con `saltarTramos=1` se le apunta al que falta.
//
// `dryRun=1` dice qué haría —incluida la lista de tramos— sin gastar una sola
// solicitud.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los otros crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Margen REAL contra maxDuration=300s. El presupuesto anterior (240s) sólo se
// miraba ENTRE tramos, así que un verify+import largo se lo saltaba: la corrida
// de 2025-04 con tramos=2 se pasó de 300s y el cliente cortó con curl(28) sin
// recibir una sola respuesta — o sea, sin veredicto. Ahora se mira también antes
// de verificar, y se corta antes para que la ruta SIEMPRE alcance a contestar.
const TIME_BUDGET_MS = 180_000;
/** Un submit+verify puede tardar; no lo empieces si no cabe. */
const MARGEN_POR_TRAMO_MS = 60_000;
const MAX_PERIODOS = 24;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

interface ResultadoTramo {
  /** "04-01→04-15" */
  tramo: string;
  importadas?: number;
  cuotaAgotada?: boolean;
  /** No alcanzó el tiempo: la solicitud queda viva y la siguiente corrida sigue. */
  pendiente?: boolean;
  nota?: string;
  error?: string;
}

interface ResultadoPeriodo {
  periodo: string;
  /** Facturas de INGRESO que ya teníamos de ese mes, antes de repescar. */
  facturasAntes: number;
  facturasDespues?: number;
  importadas?: number;
  /** Un renglón por rango pedido: con tramos=1 es el mes completo. */
  tramos?: ResultadoTramo[];
  /** Cuántos tramos se saltaron con `saltarTramos`. */
  saltados?: number;
  cuotaAgotada?: boolean;
  error?: string;
  /** Sólo con `metadata=1`: el veredicto del SAT sobre la solicitud de metadata. */
  metadata?: {
    ok: boolean;
    status?: string;
    revisadas?: number;
    canceladas?: number;
    cancelaria?: number;
    error?: string;
  };
}

async function contarIngresos(companyId: string, year: number, month: number): Promise<number> {
  return prisma.invoice.count({
    where: {
      companyId,
      tipo: "INGRESO",
      status: { not: "CANCELLED" },
      fecha: { gte: new Date(Date.UTC(year, month - 1, 1)), lt: new Date(Date.UTC(year, month, 1)) },
    },
  });
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const companyId = params.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });
  const raw = params.get("periodos");
  if (!raw) {
    return NextResponse.json(
      { error: "periodos requerido, p.ej. periodos=2025-04,2023-08" },
      { status: 400 },
    );
  }
  const periodos = parsePeriodos(raw).slice(0, MAX_PERIODOS);
  if (periodos.length === 0) {
    return NextResponse.json({ error: "ningún periodo válido en `periodos`" }, { status: 400 });
  }
  const dryRun = params.get("dryRun") === "1";
  // `metadata=1` pide METADATA en vez de XML, para el MISMO periodo.
  //
  // POR QUÉ. Medido hoy (2026-08-21) contra MARGOM 2019-06, el SAT rechazó la
  // solicitud de XML en los dos lados con un mensaje que se explica solo:
  //
  //   «La solicitud de Xml no puede contener informacion mayor a 6 años de
  //    antiguedad (código 301)»
  //
  // Dice «de Xml». Metadata es OTRO tipo de solicitud (RequestType
  // "metadata"), así que no se sabe si comparte el tope — y la diferencia
  // vale: aunque no traiga el comprobante, la metadata da folio, monto y
  // estatus de cancelación, que es con lo que se cuadran libros viejos y se
  // detectan canceladas contadas como vivas.
  //
  // NO se adivina: esto lo pregunta. Un 301 aquí cierra el tema; un aceptado
  // abre 2017-2020 sin depender de un tercero.
  const soloMetadata = params.get("metadata") === "1";
  // Partir el mes en tramos. Medido: el mes completo de 2025-04 devuelve 5002 en
  // los dos lados, así que la vía mensual está muerta para estos periodos y la
  // única salida por descarga masiva es pedir rangos DISTINTOS.
  const tramosPedidos = Number(params.get("tramos") ?? 1);
  // Saltar los primeros N tramos de cada mes.
  //
  // MEDIDO en 2024-01: el tramo 1 ya estaba completo (importadas 0, todo dedup)
  // pero re-verificarlo IGUAL descarga su paquete y se come el presupuesto, así
  // que el tramo 2 salía `pendiente` en cada corrida — para siempre. Re-correr
  // NO converge solo; hay que poder apuntarle al tramo que falta.
  const saltar = Math.max(0, Math.trunc(Number(params.get("saltarTramos") ?? 0)) || 0);
  const startedAt = Date.now();

  const empresa = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true, razonSocial: true },
  });
  if (!empresa) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  const resultados: ResultadoPeriodo[] = [];
  let cuotaAgotada = false;

  for (const { year, month } of periodos) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    const periodo = `${year}-${String(month).padStart(2, "0")}`;
    const facturasAntes = await contarIngresos(companyId, year, month);

    // La metadata no se parte en tramos: su cuota es la de su propio tipo de
    // solicitud, y aquí lo que se está midiendo es si el periodo se ACEPTA.
    // Con dryRun sí llega al SAT (es el punto) pero no escribe cancelaciones.
    if (soloMetadata) {
      const r = await syncCancelacionesPeriodo(companyId, year, month, dryRun);
      resultados.push({
        periodo,
        facturasAntes,
        metadata: {
          ok: r.ok,
          status: r.status,
          revisadas: r.checked,
          canceladas: r.cancelled,
          cancelaria: r.wouldCancel?.length,
          error: r.error,
        },
      });
      continue;
    }

    const todosLosTramos = partirMes(year, month, tramosPedidos);
    const tramos = todosLosTramos.slice(saltar);

    if (dryRun) {
      resultados.push({
        periodo,
        facturasAntes,
        tramos: tramos.map((t) => ({ tramo: etiquetaTramo(t) })),
        saltados: saltar || undefined,
      });
      continue;
    }

    const detalle: ResultadoTramo[] = [];
    let importadas = 0;
    for (const t of tramos) {
      // Con margen: entrar a un tramo que no va a caber es como no entrar, pero
      // además deja al cliente esperando hasta que lo mate el timeout.
      if (Date.now() - startedAt > TIME_BUDGET_MS - MARGEN_POR_TRAMO_MS) {
        detalle.push({ tramo: etiquetaTramo(t), pendiente: true });
        continue;
      }
      const tramo = etiquetaTramo(t);
      try {
        // force=true: sin esto reutiliza la solicitud de las últimas 24h, que es
        // justo la que ya volvió vacía. Con más de un tramo NO se fuerza: la
        // solicitud guardada trae su rango, así que reutilizarla es reutilizar
        // ESE tramo, y re-pedirlo sólo quemaría cuota del rango nuevo.
        const rango = todosLosTramos.length > 1 ? t : undefined;
        const sub = await submitSatSync(companyId, year, month, !rango, rango);
        if (!sub.ok) {
          const esCuota = sub.error.includes("5002");
          if (esCuota) cuotaAgotada = true;
          detalle.push({ tramo, cuotaAgotada: esCuota, error: sub.error });
          // La cuota es por rango: que este tramo esté quemado no dice nada de
          // los demás, así que se sigue. Lo que no vale la pena es insistir en
          // el MISMO rango — y eso ya no pasa, cada tramo se pide una vez.
          continue;
        }
        // El submit ya quedó guardado con su rango: si no hay tiempo para
        // verificar, NO se pierde nada — la siguiente corrida reutiliza esa
        // misma solicitud (sin gastar cuota) y sólo verifica e importa.
        if (Date.now() - startedAt > TIME_BUDGET_MS) {
          detalle.push({ tramo, pendiente: true, nota: "solicitado; falta verificar" });
          continue;
        }
        const ver = await verifyAndImportSatSync(
          companyId,
          sub.emitidosRequestId,
          sub.recibidosRequestId,
        );
        const imp = ver.ok && typeof ver.imported === "number" ? ver.imported : 0;
        importadas += imp;
        detalle.push({ tramo, importadas: imp, error: ver.ok ? undefined : ver.error });
      } catch (e) {
        detalle.push({ tramo, error: e instanceof Error ? e.message : String(e) });
      }
    }

    resultados.push({
      periodo,
      facturasAntes,
      facturasDespues: await contarIngresos(companyId, year, month),
      importadas,
      tramos: detalle,
      saltados: saltar || undefined,
      cuotaAgotada: detalle.some((d) => d.cuotaAgotada) || undefined,
    });
  }

  const summary = {
    ok: true,
    companyId,
    rfc: empresa.rfc,
    dryRun,
    periodosPedidos: periodos.length,
    resultados,
    cuotaAgotada,
    elapsedMs: Date.now() - startedAt,
    nota: cuotaAgotada
      ? "El SAT agotó la cuota DE POR VIDA de algún RANGO (5002). Esperar no la libera. " +
        "Si se pidió el mes completo, vuelve a intentar con tramos=2 (o más): la cuota se " +
        "cuenta por rango, así que un tramo es otra llave. Si ya venía en tramos y aun así " +
        "sale 5002, esos rangos también están quemados y queda Syntage (extractor \"invoice\")."
      : "El SAT es asíncrono: un periodo puede quedar pendiente y resolverse en otra corrida. " +
        "Re-ejecutar es GRATIS para los tramos ya solicitados —la solicitud queda guardada con " +
        "su rango y se reutiliza sin gastar cuota—, así que si algo sale `pendiente`, vuelve a " +
        "correrlo. Compara facturasAntes con facturasDespues.",
  };
  console.log("[cron/sat-repesca]", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:sat-repesca", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:sat-repesca", () => handle(req));
}
