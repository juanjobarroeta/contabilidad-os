import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { SyntageClient } from "@/lib/fiscal/cumplimiento/syntage/client";
import { estadoExportacion, exportarEntidad } from "@/lib/fiscal/cumplimiento/syntage/exportar";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cron/syntage-exportar — la exportación final antes de cerrar la
// cuenta de Syntage (ver lib/fiscal/cumplimiento/syntage/exportar.ts).
//
// Sólo corre con SYNTAGE_EXPORTAR=1 (y SYNTAGE_ENABLED=1, que exige el
// cliente). Una entidad por llamada; reporta `pendientes` para que el
// scheduler vuelva en segundos hasta terminar. Auth: CRON_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const PRESUPUESTO_MS = 200_000;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (process.env.SYNTAGE_EXPORTAR !== "1") {
    return NextResponse.json({ omitido: "SYNTAGE_EXPORTAR≠1", pendientes: 0 });
  }
  return withCronLock("cron:syntage-exportar", async () => {
    const t0 = Date.now();
    try {
      const client = new SyntageClient();
      const estado = await estadoExportacion(client);
      const siguiente = estado.pendientes[0];
      if (!siguiente) {
        console.log(
          `[syntage-exportar] TERMINADO: ${estado.completas}/${estado.entidades.length} entidades completas; atoradas: ${JSON.stringify(estado.atoradas)}`,
        );
        return NextResponse.json({
          completado: true,
          pendientes: 0,
          entidades: estado.entidades.length,
          completas: estado.completas,
          atoradas: estado.atoradas,
        });
      }
      const r = await exportarEntidad(client, siguiente, { hastaMs: t0 + PRESUPUESTO_MS });
      console.log(
        `[syntage-exportar] ${r.rfc}: ${r.registros} registros, ${r.archivosNuevos} archivos nuevos (+${r.archivosYaGuardados} ya), ` +
          `${r.errores.length ? `INCOMPLETO (${r.errores.slice(0, 3).join(" | ")})` : "completo"}` +
          `${r.avisos.length ? `, ${r.avisos.length} archivos ya no existían` : ""}; quedan ${estado.pendientes.length - (r.errores.length ? 0 : 1)}`,
      );
      return NextResponse.json({
        procesadas: 1,
        pendientes: Math.max(0, estado.pendientes.length - (r.errores.length ? 0 : 1)),
        entidades: estado.entidades.length,
        resultado: r,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[syntage-exportar] falló:", msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  });
}

export const GET = handle;
export const POST = handle;
