import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { coberturaSospechosa, UMBRAL_COBERTURA, type CoberturaPeriodo } from "@/lib/sat-cobertura";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/cron/sat-cobertura?companyId=<id>[&umbral=0.5][&todos=1]
//
// ¿Qué meses dijimos tener y no tenemos?
//
// El SAT reporta cuántos CFDIs encontró en cada solicitud (`cfdisFound`). Esto
// lo compara contra las facturas que realmente guardamos de ese mes. Un mes que
// volvió FINISHED con 3 facturas cuando el SAT dijo 800 aparece aquí.
//
// SÓLO LEE. No le pide nada al SAT, así que no gasta ni una solicitud de la
// cuota vitalicia (5002) — a diferencia de sat-backfill, que además submitea.
// Existe por eso: para poder medir el hueco sin pagarlo.
//
// Los ocho meses que encontramos a ojo (comparando contra los meses vecinos)
// pueden no ser todos. Esto los cuenta con el dato del propio SAT en vez de con
// una corazonada, y devuelve la lista de periodos para pasársela a sat-repesca.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const companyId = params.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const umbralRaw = Number(params.get("umbral") ?? UMBRAL_COBERTURA);
  const umbral = Number.isFinite(umbralRaw) && umbralRaw > 0 && umbralRaw <= 1 ? umbralRaw : UMBRAL_COBERTURA;
  const todos = params.get("todos") === "1";

  const empresa = await prisma.company.findUnique({
    where: { id: companyId },
    select: { rfc: true },
  });
  if (!empresa) return NextResponse.json({ error: "Empresa no encontrada" }, { status: 404 });

  // Todos los periodos que el SAT nos contestó alguna vez, no una ventana fija:
  // la pregunta es sobre lo que dijimos tener.
  const [solicitudes, facturas] = await Promise.all([
    // UNA fila por RANGO distinto, no todas.
    //
    // `submitSatSync` crea una fila NUEVA cada vez que un periodo se vuelve a
    // pedir pasada la ventana de 24h, así que sumar todas las FINISHED cuenta
    // el mismo mes tantas veces como se haya pedido. Medido el 2026-08-14:
    // 2026-06, 2026-07 y 2024-01 daban cobertura EXACTAMENTE 0.5 —satDijo justo
    // al doble— y 2026-06/07 nunca se tocaron con tramos: son meses que el cron
    // normal pidió dos veces.
    //
    // Con tramos SÍ hay varias filas legítimas por mes, una por rango, y esas
    // deben sumarse: los rangos son disjuntos. Por eso la llave es
    // (tipo, desde, hasta) y de cada una se toma la solicitud más reciente.
    // Las filas viejas traen desde/hasta nulos (son de antes de #632): ahí la
    // llave cae en "mes completo", que es lo que eran.
    prisma.$queryRaw<Array<{ year: number; month: number; cfdis: bigint }>>`
      SELECT year, month, SUM("cfdisFound")::bigint AS cfdis
      FROM (
        SELECT DISTINCT ON ("year", "month", "tipo", "desde", "hasta")
               "year", "month", "cfdisFound"
        FROM "SatSyncRequest"
        WHERE "companyId" = ${companyId} AND "status" = 'FINISHED'
        ORDER BY "year", "month", "tipo", "desde", "hasta", "createdAt" DESC
      ) ultima
      GROUP BY year, month
    `,
    prisma.$queryRaw<Array<{ year: number; month: number; n: bigint }>>`
      SELECT EXTRACT(YEAR FROM "fecha")::int AS year,
             EXTRACT(MONTH FROM "fecha")::int AS month,
             COUNT(*) AS n
      FROM "Invoice"
      WHERE "companyId" = ${companyId}
      GROUP BY 1, 2
    `,
  ]);

  const nuestrasPor = new Map(facturas.map((r) => [`${r.year}-${r.month}`, Number(r.n)]));
  const periodos: CoberturaPeriodo[] = solicitudes
    .map((r) => ({
      year: r.year,
      month: r.month,
      satDijo: Number(r.cfdis ?? 0),
      tenemos: nuestrasPor.get(`${r.year}-${r.month}`) ?? 0,
    }))
    .sort((a, b) => b.year - a.year || b.month - a.month);

  const sospechosos = coberturaSospechosa(periodos, umbral);

  const resp = {
    ok: true,
    companyId,
    rfc: empresa.rfc,
    umbral,
    periodosEvaluados: periodos.length,
    satDijoTotal: periodos.reduce((s, p) => s + p.satDijo, 0),
    tenemosTotal: periodos.reduce((s, p) => s + p.tenemos, 0),
    sospechosos,
    faltanCuandoMenos: sospechosos.reduce((s, p) => s + p.faltanCuandoMenos, 0),
    // Listo para pegarse en el input `periodos` de sat-repesca.
    paraRepescar: sospechosos.map((s) => s.periodo).join(","),
    // Con `todos=1` viene el detalle de cada mes, sano o no, para revisar a mano.
    periodos: todos ? periodos.map((p) => ({ ...p, periodo: `${p.year}-${String(p.month).padStart(2, "0")}` })) : undefined,
    nota:
      "Sólo lee: no le pide nada al SAT, así que no gasta cuota. Un mes con satDijo=0 no es " +
      "sospechoso (el 5004 «sin CFDIs» puede ser la verdad). Para rellenar, pasa `paraRepescar` " +
      "a sat-repesca con tramos=2 — la cuota 5002 se cuenta por rango.",
  };

  console.log(
    "[cron/sat-cobertura]",
    JSON.stringify({ companyId, rfc: empresa.rfc, sospechosos: sospechosos.length, faltan: resp.faltanCuandoMenos }),
  );
  return NextResponse.json(resp);
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
