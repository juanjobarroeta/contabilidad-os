import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { withCronLock } from "@/lib/cron-lock";
import { consultarMercado } from "@/lib/automotriz/mercado";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cron/refacciones-mercado[?limite=40] — enriquecimiento nocturno:
// busca en el mercado (Brave, country=mx) las partes de MAYOR DEMANDA que no
// tienen consulta o la tienen vieja (>30 días), para cada empresa con el
// módulo AUTOMOTRIZ. Presupuesto por corrida (default 40 búsquedas) para
// convivir con el botón de la ficha dentro de la cuota gratis de 100/día;
// si Google contesta «cuota agotada», la corrida para y mañana sigue.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los demás crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  const limite = Math.min(90, Math.max(1, Number(new URL(req.url).searchParams.get("limite") ?? 40) || 40));

  return withCronLock("refacciones-mercado", async () => {
    const empresas = await prisma.companyModule.findMany({
      where: { modulo: "AUTOMOTRIZ", habilitado: true },
      select: { companyId: true },
    });

    let busquedas = 0;
    let enriquecidas = 0;
    let sinResultados = 0;
    const errores: string[] = [];

    for (const { companyId } of empresas) {
      if (busquedas >= limite) break;
      // Candidatas: número de parte real, con demanda, sin consulta fresca.
      const candidatas = await prisma.$queryRawUnsafe<
        { id: string; numeroParte: string; descripcion: string | null }[]
      >(
        `WITH demanda AS (
           SELECT m."refaccionId" rid,
             COALESCE(SUM(CASE WHEN m.tipo = 'SALIDA_VENTA' AND m.fecha >= NOW() - interval '12 months'
                               THEN -m.cantidad ELSE 0 END), 0)::float8 d
           FROM "RefaccionMovimiento" m GROUP BY 1)
         SELECT r.id, r."numeroParte", r.descripcion
         FROM "Refaccion" r
         JOIN demanda ON demanda.rid = r.id
         LEFT JOIN "RefaccionMercado" mk ON mk."refaccionId" = r.id
         WHERE r."companyId" = $1
           AND length(r."numeroParte") BETWEEN 6 AND 20
           AND r."numeroParte" ~ '^[A-Z0-9][A-Z0-9\\-\\./]+$'
           AND demanda.d > 0
           AND (mk.id IS NULL OR mk."consultadoAt" < NOW() - interval '30 days')
         ORDER BY demanda.d DESC
         LIMIT $2`,
        companyId,
        limite - busquedas
      );

      for (const parte of candidatas) {
        if (busquedas >= limite) break;
        await new Promise((r) => setTimeout(r, 1_200)); // 1 req/s del plan gratis
        try {
          const resumen = await consultarMercado(parte.numeroParte, parte.descripcion);
          busquedas += resumen.busquedas;
          if (resumen.resultados.length === 0) sinResultados++;
          else enriquecidas++;
          await prisma.refaccionMercado.upsert({
            where: { refaccionId: parte.id },
            create: {
              companyId,
              refaccionId: parte.id,
              consultadoAt: new Date(),
              titulo: resumen.titulo,
              precioMercado: resumen.precioMercado,
              urlPrincipal: resumen.urlPrincipal,
              resultados: resumen.resultados,
            },
            update: {
              consultadoAt: new Date(),
              titulo: resumen.titulo,
              precioMercado: resumen.precioMercado,
              urlPrincipal: resumen.urlPrincipal,
              resultados: resumen.resultados,
            },
          });
        } catch (e) {
          const err = e as Error & { cuotaAgotada?: boolean };
          errores.push(`${parte.numeroParte}: ${err.message}`.slice(0, 120));
          busquedas += 1;
          if (err.cuotaAgotada) {
            return NextResponse.json({ busquedas, enriquecidas, sinResultados, cuotaAgotada: true, errores });
          }
        }
      }
    }
    return NextResponse.json({ busquedas, enriquecidas, sinResultados, errores: errores.slice(0, 10) });
  });
}

export const POST = handle;
export const GET = handle;
