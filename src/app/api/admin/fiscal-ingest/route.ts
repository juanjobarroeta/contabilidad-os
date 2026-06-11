import { NextResponse } from "next/server";
import { ingestLey, ingestDoc, IngestResult } from "@/lib/fiscal-kb/orchestrate";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/fiscal-ingest
//
// Triggers fiscal knowledge-base ingestion from *inside* the Railway network,
// where the DB (postgres.railway.internal) and OPENAI_API_KEY live. Needed
// because ingestion can't run from outside (DB is on a private host / non-HTTP
// proxy port). Fetch → chunk → embed → versioned upsert; idempotent (hash-skip).
//
// Auth: shared secret in CRON_SECRET (same as the SAT cron):
//   Authorization: Bearer <secret>   or   x-cron-secret: <secret>
//
// Body (JSON), one or many jobs:
//   { "type": "ley", "clave": "LISR" }
//   { "jobs": [ {"type":"ley","clave":"LIVA"}, {"type":"doc","clave":"GUIA-PAGOS"} ] }
//
//   type "ley" → Cámara de Diputados (LISR | LIVA | CFF | LIEPS)
//   type "doc" → SAT guías by URL (GUIA-PAGOS | GUIA-CFDI-GLOBAL); RMF needs a
//                local file and therefore the CLI, not this route.
//
// Prereqs: pgvector enabled + schema pushed (FiscalDocument/FiscalChunk, incl.
// the GUIA enum for guías). Embeddings need OPENAI_API_KEY in the environment.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";
export const maxDuration = 300; // a full ley = 300+ chunks to embed

interface Job {
  type: "ley" | "doc";
  clave: string;
  vigencia?: string;
  force?: boolean; // replace existing version even if hash unchanged (re-chunk)
}

function isAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed
  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return true;
  return req.headers.get("x-cron-secret") === secret;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body JSON inválido" }, { status: 400 });
  }

  const b = body as { jobs?: Job[]; type?: string; clave?: string; vigencia?: string };
  const jobs: Job[] = Array.isArray(b.jobs)
    ? b.jobs
    : b.type && b.clave
      ? [{ type: b.type as Job["type"], clave: b.clave, vigencia: b.vigencia }]
      : [];

  if (jobs.length === 0) {
    return NextResponse.json({ error: "Especifica { type, clave } o { jobs: [...] }" }, { status: 400 });
  }
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json({ error: "OPENAI_API_KEY no configurada en este entorno — requerida para embeddings." }, { status: 500 });
  }

  // Sequential — embeddings are rate-limited and upserts are transactional.
  const results: (IngestResult & { ok: boolean; error?: string })[] = [];
  for (const job of jobs) {
    try {
      const r =
        job.type === "ley"
          ? await ingestLey(job.clave, { force: job.force })
          : await ingestDoc(job.clave, { vigencia: job.vigencia, force: job.force });
      results.push({ ...r, ok: true });
    } catch (err) {
      results.push({ clave: job.clave, skipped: false, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ ok: allOk, results }, { status: allOk ? 200 : 207 });
}
