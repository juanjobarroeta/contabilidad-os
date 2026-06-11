# Fiscal Knowledge Base (Agente fiscal) — Design Doc

> Status: **Proposal / not yet built.** This document specifies a retrieval-augmented
> fiscal knowledge base that ingests Mexican tax authority sources (leyes vigentes,
> DOF, RMF, criterios SAT) and exposes them to the existing AI assistant as a
> citable, version-aware retrieval tool. It is the natural deepening of the
> "contador virtual experto en fiscalidad mexicana" role already declared in
> `src/lib/ai/system-prompt.ts`.

---

## 1. Problem & motivation

Today the assistant's fiscal knowledge lives as **hardcoded prose** in
`buildSystemPrompt()` (the "Reglas de razonamiento fiscal" block) plus whatever
the model remembers from training. That has three failure modes:

1. **Staleness.** Mexican fiscal law changes constantly — reformas to CFF/LISR/LIVA,
   a new **RMF** every year plus mid-year anexos, criterios SAT. A model's training
   cutoff and a static prompt both drift out of date.
2. **No authority / no citations.** The assistant can explain a rule but can't point
   to *Art. 113-J LISR* or a specific DOF publication. For a contador tool, the
   citation **is** the value — it's auditable.
3. **Hallucination risk on specifics.** Rates, thresholds, and deadlines are exactly
   the kind of precise facts LLMs get subtly wrong.

The goal: an assistant that **grounds every fiscal suggestion in retrieved,
dated source text** and refuses to invent when it has no source.

### Non-goals
- Not legal advice. The existing "no sustituye asesoría profesional" disclaimer stays.
- Not a replacement for the company-data tools (`query_invoices`, etc.). This is a
  *separate* knowledge axis: **law & doctrine**, not **this company's numbers**.
- Not a general DOF search engine. Scope is fiscal-relevant publications only.

---

## 2. Architecture overview

Three decoupled pieces. The "intelligence" stays in Claude; the new parts only
**fetch, store, and retrieve** grounded text.

```
  ┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
  │  Ingestion      │     │  Knowledge store  │     │  Retrieval tool      │
  │  (scrapers)     │ ──▶ │  pgvector on      │ ──▶ │  search_fiscal_      │
  │  scheduled cron │     │  existing Postgres│     │  knowledge(...)      │
  └─────────────────┘     └──────────────────┘     └──────────┬──────────┘
        │                                                       │
        │ leyes vigentes, DOF, RMF, criterios                   │ tool result
        ▼                                                       ▼
   normalize → chunk → embed                          existing tool-use loop
   + vigencia metadata                                (src/app/api/ai/chat/route.ts)
```

This slots into infrastructure that already exists:
- **Tool-use loop** — `src/app/api/ai/chat/route.ts` already runs up to `MAX_TOOL_ROUNDS`.
  Adding a tool is a registry entry + an executor case.
- **Tool registry** — `src/lib/ai/tools.ts` and dispatch in `src/lib/ai/tool-executor.ts`.
- **Scheduled jobs** — `src/app/api/cron/*` with `CRON_SECRET` bearer auth (same
  pattern as `sat-sync`).
- **Postgres via Prisma** — add `pgvector`; no new datastore.

---

## 3. Sources

| Source | What | Access | Priority |
|---|---|---|---|
| **Leyes vigentes** — CFF, LISR, LIVA, LIEPS, LISH, LFT (for nómina) | Texto vigente, structured by artículo | Cámara de Diputados publishes PDF/DOC of each ley vigente | **P0** — cleanest, highest value |
| **RMF + Anexos** | Resolución Miscelánea Fiscal (annual) + anexos (1-A trámites, 3 criterios, 7 compilación) | DOF / SAT | **P1** |
| **Criterios SAT** | Normativos (vinculativos) y no vinculativos (Anexo 3) | SAT portal | **P1** |
| **DOF** | Daily — filter to **SHCP/SAT** publications only | DOF daily index / open-data | **P2** (high noise) |
| **Reglamentos** (RLISR, RLIVA, RCFF) | Reglamentos de las leyes | Cámara de Diputados | **P2** |
| **Jurisprudencia / tesis** (TFJA, SCJN) | Precedent | Respective portals | **P3** (later, heavier) |

**Legality:** all of the above are official government publications (dominio público).
Scraping is fine; respect rate limits, cache aggressively, and identify the client
honestly. DOF in particular should be polled, not hammered.

---

## 4. The hard part: temporal versioning (vigencia)

**This is the make-or-break design decision.** Fiscal law is *versioned in time*. A
question about an ISR provisional for periodo 2024-06 must be answered with the law
**in force in June 2024**, not today's text. A naive "scrape current text, embed,
retrieve" pipeline produces *confidently wrong* answers the moment a reforma lands.

Requirements:
- Every chunk carries `vigenciaDesde` and `vigenciaHasta` (nullable = "still in force").
- Retrieval accepts an optional `fechaVigencia` (defaults to today) and filters to
  chunks in force on that date.
- When a ley is re-published with reforms, the ingestion pipeline **closes** the prior
  version (`vigenciaHasta = dayBefore(newPublication)`) and inserts the new one, rather
  than overwriting. We keep history.
- The assistant must be told (system prompt addition) to pass the relevant fiscal
  period's date when the question is period-specific.

Getting this right is what separates a real fiscal assistant from a demo. Everything
else is standard RAG.

---

## 5. Data model (Prisma)

```prisma
model FiscalDocument {
  id            String   @id @default(cuid())
  source        FiscalSource          // LEY | RMF | CRITERIO | DOF | REGLAMENTO | TESIS
  clave         String                // e.g. "LISR", "CFF", "RMF-2026"
  titulo        String
  url           String                // canonical source URL
  publicadoDof  DateTime?             // DOF publication date, if applicable
  vigenciaDesde DateTime
  vigenciaHasta DateTime?             // null = still in force
  hash          String                // content hash; skip re-ingest if unchanged
  chunks        FiscalChunk[]
  createdAt     DateTime @default(now())

  @@unique([clave, vigenciaDesde])
  @@index([source, clave])
}

model FiscalChunk {
  id            String   @id @default(cuid())
  documentId    String
  document      FiscalDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)
  articulo      String?               // "113-J", "1-B", "Regla 3.13.1"
  fraccion      String?
  texto         String                // the chunk text
  embedding     Unsupported("vector(1024)")  // pgvector; dim matches model
  vigenciaDesde DateTime              // denormalized from document for fast filtering
  vigenciaHasta DateTime?
  regimenes     String[]              // optional applicability tags: ["RESICO_PF", ...]

  @@index([documentId])
}

enum FiscalSource { LEY RMF CRITERIO DOF REGLAMENTO TESIS }
```

Notes:
- `embedding` uses `Unsupported("vector(N)")` — Prisma doesn't natively type pgvector,
  so the similarity query runs through `prisma.$queryRaw` with the `<=>` cosine operator
  and an `ivfflat`/`hnsw` index created in a migration.
- `vigencia*` is denormalized onto the chunk so the vector search can filter by date in
  one query without a join.

---

## 6. Ingestion pipeline

A library under `src/lib/fiscal/ingest/` with one normalizer per source type, driven by
a cron route.

```
src/lib/fiscal/
  ingest/
    leyes.ts        # fetch + parse Cámara de Diputados PDFs (pdf-parse already a dep)
    rmf.ts          # RMF + anexos
    dof.ts          # daily index, filter SHCP/SAT
    criterios.ts
  chunk.ts          # article-aware splitter (split on "Artículo N.-")
  embed.ts          # batch embeddings
  upsert.ts         # vigencia-aware version close + insert
```

Pipeline per document:
1. **Fetch** the source (HTTP). Compute `hash`; if unchanged vs latest stored version, skip.
2. **Parse** to plain text. `pdf-parse` is already a dependency. Strip headers/footers.
3. **Chunk** — *article-aware*, not fixed-size. Split on `Artículo N.-` / `Regla N.N.N`
   boundaries so each chunk is a citable unit. Long articles sub-split with overlap.
4. **Embed** the chunks in batches.
5. **Upsert with vigencia** — if a newer version of the same `clave` exists, close the
   prior version's `vigenciaHasta`; insert the new `FiscalDocument` + `FiscalChunk`s.

**Schedule** (`src/app/api/cron/fiscal-ingest/route.ts`, `CRON_SECRET` auth):
- DOF index: daily.
- Leyes / reglamentos: weekly (cheap hash check; re-embed only on change).
- RMF / criterios: weekly, plus a manual trigger for known annual publication windows.

---

## 7. Embeddings

Anthropic does **not** provide an embeddings endpoint — Claude is the generator, not the
embedder. Options:

- **Voyage AI** (`voyage-3` / `voyage-3-large`) — Anthropic's recommended pairing, strong
  multilingual + legal/technical retrieval. **Recommended.** Adds one env var + dep.
- **OpenAI `text-embedding-3-large`** — already have `OPENAI_API_KEY` wired for Whisper
  voice notes; lowest setup friction if we want zero new vendors. Solid Spanish support.

Recommendation: start on whichever is fastest to wire (likely OpenAI, already present),
keep the embedder behind `src/lib/fiscal/embed.ts` so swapping to Voyage later is a
one-file change. Keep the vector dimension in the model name → migration in sync.

---

## 8. Retrieval tool

New entry in `src/lib/ai/tools.ts`:

```ts
{
  name: "search_fiscal_knowledge",
  description:
    "Busca en la legislación fiscal mexicana vigente (CFF, LISR, LIVA, RMF, " +
    "criterios SAT, DOF). Devuelve fragmentos con su cita (artículo/fuente/fecha). " +
    "Úsalo SIEMPRE antes de afirmar una regla, tasa, plazo o requisito fiscal. " +
    "No inventes fundamentos: si no hay resultado, dilo.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Consulta en lenguaje natural" },
      fecha_vigencia: {
        type: "string",
        description: "ISO date del periodo fiscal relevante. Default: hoy. " +
          "Úsalo para preguntas sobre periodos pasados.",
      },
      fuentes: {
        type: "array",
        items: { type: "string", enum: ["LEY","RMF","CRITERIO","DOF","REGLAMENTO"] },
        description: "Filtrar por tipo de fuente (opcional)",
      },
      regimen: { type: "string", description: "Filtrar por régimen aplicable (opcional)" },
    },
    required: ["query"],
  },
}
```

Dispatch case in `src/lib/ai/tool-executor.ts` → `src/lib/fiscal/search.ts`:
1. Embed `query`.
2. `prisma.$queryRaw` cosine search (`embedding <=> $1`), **filtered** by
   `vigenciaDesde <= fecha AND (vigenciaHasta IS NULL OR vigenciaHasta >= fecha)`,
   plus optional `fuentes` / `regimen`.
3. Return top-K chunks as JSON: `{ texto, cita: "Art. 113-J LISR", fuente, url,
   vigenciaDesde, publicadoDof }`.

The model then composes an answer **citing** the returned `cita`/`url`. Because the tool
returns the source text, the assistant is grounded rather than recalling.

### System-prompt additions
- Instruct: *always* call `search_fiscal_knowledge` before stating a rule/rate/deadline;
  cite the returned `cita`; if no result, say so and don't fabricate a fundamento.
- Instruct: for period-specific questions, pass `fecha_vigencia` for that period.

---

## 9. Guardrails

- **Citations mandatory** — no fundamento without a retrieved source. This is the core
  anti-hallucination lever.
- **Vigencia honesty** — surface the `vigenciaDesde`/`publicadoDof` so the user sees how
  current the basis is.
- **Disclaimer preserved** — orientation, not asesoría.
- **Confidence floor** — if top similarity is below a threshold, the tool returns "sin
  fundamento suficiente" rather than weak matches the model might over-trust.
- **Scope isolation** — fiscal knowledge (law) is a distinct tool from company-data tools;
  don't let the model blur "the law says" with "your books show".

---

## 10. Phased execution

- **Phase 0 — Spike (½–1 day).** pgvector migration + `FiscalChunk`; ingest **one law**
  (LISR) by hand; raw `$queryRaw` cosine search in a script. Validate retrieval quality
  on 10 real fiscal questions. *Decision gate before investing further.*
- **Phase 1 — Vertical slice.** Article-aware chunker; embed pipeline; `search_fiscal_knowledge`
  tool wired into the chat assistant; system-prompt update. Sources: CFF + LISR + LIVA.
- **Phase 2 — Vigencia.** Version-close logic; `fecha_vigencia` filtering; backfill ≥1
  prior version of one law to prove time-travel works.
- **Phase 3 — Coverage.** RMF + anexos + criterios SAT; weekly cron; hash-based skip.
- **Phase 4 — DOF.** Daily index with SHCP/SAT filtering; dedup against already-ingested
  leyes (DOF often *is* the reforma source).
- **Phase 5 — Polish.** Confidence floor tuning, reranking, optional Voyage swap,
  citations surfaced in the WhatsApp channel.

---

## 11. Open questions

- **Embeddings vendor** — start OpenAI (already wired) vs Voyage (better, new dep)?
- **Reranking** — is top-K cosine enough, or add a reranker (Voyage rerank / Cohere)
  for precision on dense legal text?
- **DOF filtering precision** — rules-based (emisor = SHCP/SAT) vs a lightweight
  classifier? Start rules-based.
- **Storage growth** — multiple vigencia versions × all leyes × chunks. Estimate after
  Phase 1; pgvector on current Postgres is fine at this scale.
- **Refresh cadence vs cost** — re-embedding on every minor change is wasteful; the
  hash-skip + article-level diffing should keep embedding spend low.

---

## 12. Cost & effort (rough)

- **Build:** Phase 0–1 ≈ a few days for a working, cited fiscal assistant over the core
  three laws. Vigencia (Phase 2) is the next meaningful chunk of work.
- **Run:** embeddings are one-time per document version (cheap — laws are small relative
  to LLM context); query-time cost is one embedding per search + the existing chat tokens.
  No new infra (pgvector on current Postgres).
