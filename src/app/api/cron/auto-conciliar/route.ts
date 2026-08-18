import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { autoConciliarEmpresa } from "@/lib/bancos/auto-conciliar";
import { detectarMovimientosSinCfdi, periodoMesActual } from "@/lib/bancos/movimientos-sin-cfdi";

// ─────────────────────────────────────────────────────────────────────────────
// POST (or GET) /api/cron/auto-conciliar
//
// El "contador AI" diario para bancos: corre la auto-conciliación de alta
// confianza para cada empresa activa. Sólo aplica coincidencias inequívocas
// (mismo umbral que el botón de conciliar). Idempotente — sólo toca
// transacciones UNMATCHED; nunca des-concilia. Barato (DB-only).
//
// Tras conciliar, corre el detector de movimientos SIN CFDI (cruce de dos vías:
// banco-sin-CFDI y CFDI-sin-banco) sobre los datos recién conciliados, y
// levanta/resuelve Hallazgos idempotentes (dos dedupeKeys por empresa+periodo).
// SÓLO LECTURA — no escribe en el ledger ni des-concilia.
//
// Auth: secreto compartido en CRON_SECRET, pasado como
//   Authorization: Bearer <secret>   o   x-cron-secret: <secret>
//
// Query opcional: ?companyId=<id> para conciliar una sola empresa.
//   ?periodo=YYYY-MM para el cruce sin-CFDI (por defecto el mes en curso).
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if not configured
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

async function handle(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const only = url.searchParams.get("companyId");
  const periodo = url.searchParams.get("periodo") ?? periodoMesActual();

  const companies = only
    ? [{ id: only }]
    : await prisma.company.findMany({ where: { isActive: true }, select: { id: true } });

  const resultados = [];
  let errores = 0;
  let totalMatched = 0;
  // Por qué SÍ o por qué NO concilió impuestos por línea de captura. La primera
  // corrida global dio cero y hubo que adivinar la causa; estos contadores
  // convierten la próxima pregunta en una lectura.
  const impuestosLc = { candidatos: 0, conciliados: 0, sinDeclaracion: 0, ambiguos: 0 };
  let sinCfdiHallazgos = 0;
  let sinCfdiResueltos = 0;
  for (const c of companies) {
    try {
      const res = await autoConciliarEmpresa(c.id);
      totalMatched += res.matched;
      impuestosLc.candidatos += res.impuestosLc.candidatos;
      impuestosLc.conciliados += res.impuestosLc.conciliados;
      impuestosLc.sinDeclaracion += res.impuestosLc.sinDeclaracion;
      impuestosLc.ambiguos += res.impuestosLc.ambiguos;
      // Tras conciliar, cruzar banco↔CFDI en ambos sentidos sobre los datos
      // recién conciliados. Best-effort: un error aquí no debe tirar el cron.
      let sinCfdi: { abierto: boolean; resuelto: boolean; error?: string };
      try {
        const det = await detectarMovimientosSinCfdi(c.id, periodo);
        const abierto = det.bancoHallazgoAbierto || det.cfdiHallazgoAbierto;
        const resuelto = det.bancoHallazgoResuelto || det.cfdiHallazgoResuelto;
        if (abierto) sinCfdiHallazgos++;
        if (resuelto) sinCfdiResueltos++;
        sinCfdi = { abierto, resuelto };
      } catch (e) {
        sinCfdi = { abierto: false, resuelto: false, error: e instanceof Error ? e.message : String(e) };
      }
      resultados.push({ companyId: c.id, ...res, sinCfdi });
    } catch (e) {
      errores++;
      resultados.push({ companyId: c.id, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({
    ok: true,
    companies: companies.length,
    totalMatched,
    impuestosLc,
    periodo,
    sinCfdiHallazgos,
    sinCfdiResueltos,
    errores,
    resultados,
  });
}

export async function POST(req: Request) {
  return withCronLock("cron:auto-conciliar", () => handle(req));
}

export async function GET(req: Request) {
  return withCronLock("cron:auto-conciliar", () => handle(req));
}
