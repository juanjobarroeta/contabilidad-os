import { NextResponse } from "next/server";
import { withCronLock } from "@/lib/cron-lock";
import { SyntageClient } from "@/lib/fiscal/cumplimiento/syntage/client";
import { rellenarNombresDeCuentas } from "@/lib/contabilidad/ce-import-syntage";

// ─────────────────────────────────────────────────────────────────────────────
// GET/POST /api/cron/ce-nombrar-cuentas?companyId=<id>[&maxCatalogos=40]
//
// Le pone NOMBRE a las cuentas que se quedaron con su propio código.
//
// POR QUÉ IMPORTA. Una cuenta cuyo `nombre` es su número rompe cualquier
// conciliación por familia: el dinero está bien contabilizado y aun así cae en
// el bucket «sin explicar», porque no hay con qué agruparlo. Medido en MARGOM:
// 16 cuentas así, y `1301-0028-0000` sola trae $6.98M —casi con seguridad
// TRAVELER, que tiene $6.81M en piso—. Sin esto, el hueco de $33.2M contra la
// balanza no se puede desarmar.
//
// DE DÓNDE SALEN LOS NOMBRES. De los catálogos (fileType "CT") ya presentados
// al SAT y guardados en Syntage. El importador de CE toma sólo el MÁS RECIENTE
// y tira los demás —MARGOM tiene 27—, así que una cuenta que no venía con
// `Desc` en ése se quedó sin nombre para siempre. Esto los recorre del más
// nuevo al más viejo y para en cuanto no queda nada pendiente.
//
// SÓLO ACTUALIZA, NUNCA CREA. El plan de cuentas cambió en 2024-10: antes se
// presentaba con el código agrupador del SAT (inventario = `115`) y desde
// entonces con la numeración propia (`1301-0000-0000`). Si esto pudiera crear,
// leer un catálogo viejo duplicaría el catálogo bajo dos numeraciones. Como
// sólo pega nombres sobre cuentas existentes, da igual de qué generación venga
// el archivo.
//
// Idempotente y barato de repetir: en la segunda corrida `sinNombreAntes` sale
// 0 y no se baja un solo XML.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret).
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
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const maxRaw = Number(params.get("maxCatalogos") ?? 40);
  const maxCatalogos = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.trunc(maxRaw) : 40;

  const startedAt = Date.now();
  const r = await rellenarNombresDeCuentas(companyId, new SyntageClient(), { maxCatalogos });

  const resp = {
    ...r,
    elapsedMs: Date.now() - startedAt,
    nota:
      "Los nombres salen de los catálogos CT ya presentados al SAT. Sólo actualiza cuentas " +
      "existentes: nunca crea, porque el plan de cuentas cambió de numeración en 2024-10 y " +
      "leer un catálogo viejo duplicaría el catálogo. `siguenSinNombre` son las que no " +
      "aparecen con Desc en NINGÚN catálogo presentado — ésas van con el contador, no con " +
      "otro barrido.",
  };

  console.log(
    "[cron/ce-nombrar-cuentas]",
    JSON.stringify({
      companyId,
      rfc: r.rfc,
      sinNombreAntes: r.sinNombreAntes,
      nombradas: r.nombradas,
      siguenSinNombre: r.siguenSinNombre.length,
      catalogos: r.catalogosLeidos.length,
    }),
  );
  return NextResponse.json(resp);
}

export async function POST(req: Request) {
  return withCronLock("cron:ce-nombrar-cuentas", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:ce-nombrar-cuentas", () => handle(req));
}
