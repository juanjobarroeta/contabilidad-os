import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { prisma } from "@/lib/prisma";
import { SyntageClient } from "@/lib/fiscal/cumplimiento/syntage/client";
import {
  borrarEntidadExportada,
  idDeEntidad,
  TIPO_BORRADO,
  TIPO_COMPLETO,
} from "@/lib/fiscal/cumplimiento/syntage/exportar";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/cron/syntage-borrar — borra de Syntage (credenciales + entidad)
// las entidades CUYA EXPORTACIÓN TERMINÓ SIN ERRORES. Irreversible: Syntage
// pierde el historial extraído; nuestra copia es `SyntageArchivo`.
//
// Sólo corre con SYNTAGE_BORRAR=1 (y SYNTAGE_ENABLED=1). Las entidades sin
// `export:completo` no se tocan y se reportan. Auth: CRON_SECRET.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const POR_LLAMADA = 10;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

async function handle(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (process.env.SYNTAGE_BORRAR !== "1") {
    return NextResponse.json({ omitido: "SYNTAGE_BORRAR≠1", pendientes: 0 });
  }
  return withCronLock("cron:syntage-borrar", async () => {
    try {
      const client = new SyntageClient();
      const entidades = await client.listEntities();
      const completas = new Set(
        (await prisma.syntageArchivo.findMany({ where: { tipo: TIPO_COMPLETO }, select: { entityId: true } })).map(
          (f) => f.entityId,
        ),
      );
      // Un borrado se intenta UNA vez por entidad: si falló, queda anotado
      // (tipo «borrado» con errores) y se reporta en vez de reintentar en bucle.
      const intentadas = new Set(
        (await prisma.syntageArchivo.findMany({ where: { tipo: TIPO_BORRADO }, select: { entityId: true } })).map(
          (f) => f.entityId,
        ),
      );
      const borrables = entidades.filter((e) => completas.has(idDeEntidad(e)) && !intentadas.has(idDeEntidad(e)));
      const fallidas = entidades.filter((e) => intentadas.has(idDeEntidad(e))).length;
      const sinExport = entidades.filter((e) => !completas.has(idDeEntidad(e))).length;
      const resultados = [];
      for (const e of borrables.slice(0, POR_LLAMADA)) {
        const r = await borrarEntidadExportada(client, e);
        resultados.push(r);
        console.log(
          `[syntage-borrar] ${r.rfc}: ${r.borrada ? "BORRADA" : "NO borrada"}, ${r.credenciales} credenciales${r.errores.length ? ` — ${r.errores.join(" | ")}` : ""}`,
        );
      }
      const restantes = Math.max(0, borrables.length - resultados.length);
      if (!restantes) {
        console.log(
          `[syntage-borrar] TERMINADO. Quedan en Syntage: ${sinExport} sin export completo, ${fallidas + resultados.filter((r) => !r.borrada).length} con borrado fallido.`,
        );
      }
      return NextResponse.json({ procesadas: resultados.length, pendientes: restantes, sinExport, fallidas, resultados });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[syntage-borrar] falló:", msg);
      return NextResponse.json({ error: msg }, { status: 500 });
    }
  });
}

export const GET = handle;
export const POST = handle;
