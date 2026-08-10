import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/interes-piso
//
// Acumula el COSTO FINANCIERO del plan piso por unidad y mes vencido:
//   monto = costoCompra × tasa anual × (días en piso ese mes) / 365
// desde la compra hasta la venta (o hoy), sólo MESES COMPLETOS transcurridos
// (el mes en curso se acumula al cerrar). La tasa: la de la unidad, o la
// default de AutomotrizConfig de la empresa. Sin tasa → no acumula.
//
// Idempotente por (vehiculoId, tipo INTERES_PISO, concepto "… YYYY-MM"): las
// corridas re-ejecutan sin duplicar. El costo resta en la utilidad por VIN y
// alimenta la alerta de inventario detenido con cifra real, no estimada.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los demás crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const TIME_BUDGET_MS = 240_000;
const MS_DIA = 86_400_000;
const PAGE = 200;

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const claveMes = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const onlyCompanyId = url.searchParams.get("companyId");
  const startedAt = Date.now();

  // Tasas default por empresa (una consulta).
  const configs = await prisma.automotrizConfig.findMany({
    where: { planPisoTasaAnual: { not: null }, ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}) },
    select: { companyId: true, planPisoTasaAnual: true },
  });
  const tasaDefault = new Map(configs.map((c) => [c.companyId, c.planPisoTasaAnual!]));

  // Primer día del mes en curso (UTC) — sólo se acumulan meses anteriores.
  const ahora = new Date();
  const inicioMesActual = new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), 1));

  let lastId: string | undefined;
  let unidades = 0;
  let cargos = 0;
  let montoTotal = 0;

  while (Date.now() - startedAt < TIME_BUDGET_MS) {
    const page = await prisma.vehiculo.findMany({
      where: {
        fechaCompra: { not: null },
        costoCompra: { gt: 0 },
        ...(onlyCompanyId ? { companyId: onlyCompanyId } : {}),
        company: { modules: { some: { modulo: "AUTOMOTRIZ", habilitado: true } } },
        ...(lastId ? { id: { gt: lastId } } : {}),
      },
      select: {
        id: true, companyId: true, costoCompra: true, fechaCompra: true, fechaVenta: true,
        planPisoTasaAnual: true, planPisoInicio: true,
        costos: { where: { tipo: "INTERES_PISO" }, select: { concepto: true } },
      },
      orderBy: { id: "asc" },
      take: PAGE,
    });
    if (page.length === 0) break;

    for (const v of page) {
      const tasa = v.planPisoTasaAnual ?? tasaDefault.get(v.companyId);
      if (!tasa || tasa <= 0) continue;
      unidades++;

      const yaCargados = new Set(v.costos.map((c) => c.concepto));
      // El financiamiento corre desde planPisoInicio si se capturó; si no,
      // desde la compra. Termina en la venta (o sigue corriendo).
      const inicio = v.planPisoInicio ?? v.fechaCompra!;
      const fin = v.fechaVenta ?? inicioMesActual;

      const nuevos: Array<{ concepto: string; monto: number; fecha: Date }> = [];
      // Recorre cada mes calendario COMPLETO transcurrido desde `inicio`.
      let mes = new Date(Date.UTC(inicio.getUTCFullYear(), inicio.getUTCMonth(), 1));
      while (mes < inicioMesActual) {
        const mesFin = new Date(Date.UTC(mes.getUTCFullYear(), mes.getUTCMonth() + 1, 1));
        const desde = inicio > mes ? inicio : mes;
        const hasta = fin < mesFin ? fin : mesFin;
        const dias = Math.max(0, Math.round((hasta.getTime() - desde.getTime()) / MS_DIA));
        const concepto = `Interés plan piso ${claveMes(mes)}`;
        if (dias > 0 && !yaCargados.has(concepto)) {
          const monto = r2((v.costoCompra * tasa * dias) / 365);
          if (monto >= 0.01) {
            nuevos.push({ concepto, monto, fecha: new Date(mesFin.getTime() - MS_DIA) });
          }
        }
        if (hasta < mesFin) break; // la unidad se vendió dentro de este mes
        mes = mesFin;
      }

      if (nuevos.length > 0) {
        await prisma.vehiculoCosto.createMany({
          data: nuevos.map((n) => ({
            vehiculoId: v.id,
            tipo: "INTERES_PISO" as const,
            concepto: n.concepto,
            monto: n.monto,
            fecha: n.fecha,
          })),
        });
        cargos += nuevos.length;
        montoTotal = r2(montoTotal + nuevos.reduce((s, n) => s + n.monto, 0));
      }
    }

    lastId = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }

  const summary = { ok: true, unidades, cargos, montoTotal, elapsedMs: Date.now() - startedAt };
  console.log("[cron/interes-piso] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:interes-piso", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:interes-piso", () => handle(req));
}
