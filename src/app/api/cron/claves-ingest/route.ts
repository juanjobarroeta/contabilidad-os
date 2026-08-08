import { NextResponse } from "next/server";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { withCronLock } from "@/lib/cron-lock";

// ─────────────────────────────────────────────────────────────────────────────
// POST (o GET) /api/cron/claves-ingest[?anio=2022]
//
// Ingesta del Código de Claves Vehiculares (Anexo 15 RMF, sección C) al
// catálogo global `ClaveVehicularCatalogo`, desde los JSON versionados en
// src/data/anexo15/<año>.json (2019–2026, extraídos del DOF/SAT). El catálogo
// viaja con el producto: cada deploy puede poblarlo con una sola llamada, sin
// editor SQL. Idempotente — upsert por clave, procesando los años en orden
// ascendente para que en colisiones gane el más reciente.
//
// Auth: CRON_SECRET (Bearer o x-cron-secret), igual que los demás crons.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const LOTE = 1000;

interface ClaveRow {
  clave: string;
  empresa: string;
  modelo: string;
  version: string | null;
}

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  if (req.headers.get("x-cron-secret") === secret) return true;
  return false;
}

const esc = (s: string) => s.replaceAll("'", "''");

async function handle(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const soloAnio = url.searchParams.get("anio");
  const dir = path.join(process.cwd(), "src", "data", "anexo15");

  const archivos = (await readdir(dir))
    .filter((f) => /^\d{4}\.json$/.test(f))
    .sort(); // ascendente: en colisiones de clave gana el año más reciente
  const anios = archivos
    .map((f) => f.slice(0, 4))
    .filter((a) => !soloAnio || a === soloAnio);
  if (anios.length === 0) {
    return NextResponse.json({ error: `Sin catálogo para ${soloAnio ?? "ningún año"}` }, { status: 404 });
  }

  const porAnio: Record<string, number> = {};
  for (const anio of anios) {
    const rows = JSON.parse(await readFile(path.join(dir, `${anio}.json`), "utf8")) as ClaveRow[];
    const fuente = `Anexo 15 RMF ${anio}`;
    let procesadas = 0;
    for (let i = 0; i < rows.length; i += LOTE) {
      const lote = rows.slice(i, i + LOTE);
      const values = lote
        .map(
          (r) =>
            `('${esc(r.clave)}','${esc(r.empresa)}','${esc(r.modelo)}',${r.version == null ? "NULL" : `'${esc(r.version)}'`},'${esc(fuente)}',now(),now())`
        )
        .join(",");
      procesadas += await prisma.$executeRawUnsafe(
        `INSERT INTO "ClaveVehicularCatalogo" ("clave","empresa","modelo","version","fuente","createdAt","updatedAt")
         VALUES ${values}
         ON CONFLICT ("clave") DO UPDATE SET
           "empresa"=EXCLUDED."empresa","modelo"=EXCLUDED."modelo",
           "version"=EXCLUDED."version","fuente"=EXCLUDED."fuente","updatedAt"=now()`
      );
    }
    porAnio[anio] = procesadas;
  }

  const total = await prisma.claveVehicularCatalogo.count();
  const summary = { ok: true, porAnio, totalCatalogo: total };
  console.log("[cron/claves-ingest] done:", JSON.stringify(summary));
  return NextResponse.json(summary);
}

export async function POST(req: Request) {
  return withCronLock("cron:claves-ingest", () => handle(req));
}
export async function GET(req: Request) {
  return withCronLock("cron:claves-ingest", () => handle(req));
}
