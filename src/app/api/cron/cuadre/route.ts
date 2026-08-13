import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cuadreDeCfdis, cuadreDeIngresos } from "@/lib/automotriz/cuadre";
import { gastosDeOperacion } from "@/lib/automotriz/resultados-gastos";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/cron/cuadre?companyId=<id>&anio=<YYYY>[&peores=N]
//
// Diagnóstico de SOLO LECTURA: ¿cada peso facturado está contado exactamente
// una vez? Devuelve, por empresa y ejercicio, cuánto dinero se le cargó de más
// a las facturas (sobre-atribución), cuánto se pierde en residuos de facturas
// atribuidas a medias, y cuánto llega legítimamente al gasto.
//
// Sin companyId recorre TODAS las empresas y devuelve sólo los totales de cada
// una — así se ve de un vistazo si el problema es de una agencia o del motor.
//
// No escribe nada. Auth: CRON_SECRET. Salen importes agregados e IDs de
// factura; ni clientes, ni proveedores, ni conceptos de terceros más allá del
// que explica cada descuadre.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  const anio = Number(params.get("anio") ?? new Date().getFullYear());
  if (!Number.isFinite(anio) || anio < 2000 || anio > 2100) {
    return NextResponse.json({ error: "anio inválido" }, { status: 400 });
  }
  const peores = Math.min(Number(params.get("peores") ?? 15) || 15, 50);

  const desde = new Date(Date.UTC(anio, 0, 1));
  const hasta = new Date(Date.UTC(anio + 1, 0, 1));

  const empresas = companyId
    ? [{ id: companyId }]
    : await prisma.company.findMany({ select: { id: true }, orderBy: { id: "asc" } });

  // La pérdida de MARGOM no está en las unidades: la utilidad BRUTA es positiva
  // los dos años (+$103.1M en 2024, +$158.5M en 2025) y el número negativo
  // aparece entero DEBAJO de la línea bruta, en la estructura ($133.0M y
  // $192.5M). Con `gastos=1` se devuelve esa estructura desglosada por cuenta —
  // que hasta ahora nadie había medido— para poder ver si es gasto real o
  // inventario mal clasificado, que es el mismo defecto de P1 del otro lado.
  const conGastos = params.get("gastos") === "1";

  const resultados = [];
  for (const e of empresas) {
    const r = await cuadreDeCfdis(prisma, e.id, desde, hasta, {
      // Al barrer todas las empresas sólo interesan los totales.
      peores: companyId ? peores : 3,
    });
    // El espejo del ingreso. El gasto se calcula tomando TODOS los EGRESO y
    // clasificándolos, así que nada se pierde; el ingreso NO se suma de los
    // CFDIs sino de Vehiculo.precioVenta, ServicioVenta y otrosIngresos —que
    // además sólo mira claves 8014%—. Un CFDI de venta que ningún derivador
    // reclama no se cuenta en ningún lado, y eso es lo que explica que «tenemos
    // todos los CFDIs» y aun así el ingreso quede corto.
    Object.assign(r, { ingreso: await cuadreDeIngresos(prisma, e.id, desde, hasta) });

    if (conGastos) {
      const g = await gastosDeOperacion(prisma, e.id, desde, hasta);
      Object.assign(r, {
        estructura: {
          total: g.total,
          // Ordenadas de mayor a menor: el problema, si lo hay, está arriba.
          lineas: g.lineas.slice(0, 25),
          sinClasificar: g.sinClasificar,
          // Ni los anticipos ni el ISAN entran al total; se reportan porque son
          // los dos que más veces se han contado mal.
          anticipos: g.anticipos,
          isan: g.isan,
        },
      });
    }
    resultados.push(r);
  }

  // Ordenadas por el dinero inventado: la peor arriba.
  resultados.sort((a, b) => b.egreso.sobreAtribuidas.exceso - a.egreso.sobreAtribuidas.exceso);

  const totalExceso = resultados.reduce((s, r) => s + r.egreso.sobreAtribuidas.exceso, 0);
  const totalResiduo = resultados.reduce((s, r) => s + r.egreso.parciales.residuo, 0);
  const summary = {
    ok: true,
    anio,
    empresas: resultados.length,
    excesoTotal: Math.round(totalExceso * 100) / 100,
    residuoTotal: Math.round(totalResiduo * 100) / 100,
    todasCuadran: resultados.every((r) => r.cuadra),
  };
  console.log("[cron/cuadre]", JSON.stringify(summary));

  return NextResponse.json({ ...summary, resultados });
}

export async function POST(req: Request) {
  return handle(req);
}
export async function GET(req: Request) {
  return handle(req);
}
