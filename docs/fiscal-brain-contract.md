# Contract: the Fiscal Brain ⇄ its consumers

> **Vision.** A living fiscal *brain* that keeps reading the law and stays current,
> and on top of it the accounting software just *hooks up* — it computes, audits,
> and advises, but holds **zero fiscal knowledge of its own**. When a law changes,
> we update the brain and every calculation downstream is correct without touching
> the software.

This document is the **contract**: the shape of what the brain serves and the
interface its consumers call. Define it once here; both workstreams build to it in
parallel without colliding.

---

## 1. Three consumers, one brain

```
                         ┌─────────────────────────┐
                         │      FISCAL BRAIN        │
                         │  (this workstream)       │
                         │                          │
                         │  • narrative + citations │  ← search_fiscal_knowledge (exists)
                         │  • structured rules      │  ← getRule / listRules (new)
                         │  • checks (assertions)   │  ← listChecks (new)
                         │  • vigencia / freshness  │
                         └────────────┬─────────────┘
                                      │  one query interface (this contract)
          ┌───────────────────────────┼───────────────────────────┐
          ▼                           ▼                           ▼
   ┌───────────────┐         ┌──────────────────┐        ┌──────────────────┐
   │  ASSISTANT    │         │     ENGINE       │        │  AUDITOR / VIGÍA  │
   │  (chat UI)    │         │  (other chat)    │        │  (24/7 contador)  │
   │  prose answers│         │ computes ISR/IVA │        │ scans company data│
   │  + citations  │         │  & deducciones   │        │ flags + suggests  │
   └───────────────┘         └──────────────────┘        └──────────────────┘
```

- **Assistant** — already live; consumes the *narrative* layer for prose + citations.
- **Engine** — the other workstream; consumes *structured rules* to compute.
- **Auditor** — the "24/7 highly-knowledgeable contador"; consumes *checks* + rules,
  runs them against each company's data on a schedule, raises findings and suggested
  alterations.

**Governing principle:** no consumer hardcodes a fiscal constant. No `0.16`, no
`$175,000`, no depreciation %. Every value and applicability decision comes from the
brain, resolved **as of a date**.

---

## 2. Two layers in the brain

| Layer | Shape | Consumed by | Status |
|---|---|---|---|
| **Narrative** | prose chunks + embeddings + citations | Assistant, humans | **exists** (`src/lib/fiscal-kb/`, `search_fiscal_knowledge`) |
| **Structured** | typed rules + checks | Engine, Auditor | **to build** (this contract) |

The two are cross-linked: every structured rule carries a `fundamento` that points
back to the narrative chunk it was distilled from, so a computed number can always be
traced to citable text.

---

## 3. The rule schema

A `FiscalRule` is one declarative fact the software can branch on.

```ts
type Sector =
  | "GENERAL" | "CONSTRUCCION" | "AGAPES" | "AUTOTRANSPORTE" | "INDUSTRIA"
  | "JOYERIA" | "RESTAURANTES" | "ARRENDAMIENTO" | "PLATAFORMAS" | "EXPORTACION";

type Aplicabilidad = {
  regimenes: string[] | "*";     // SAT régimen codes, e.g. ["601","626"], or "*"
  actividades: Sector[] | "*";   // sector tags, or "*"
  tipoPersona: "PF" | "PM" | "*";
  condiciones?: Predicado[];      // optional extra predicates (see §5)
};

type Vigencia = { desde: string; hasta: string | null };  // ISO dates; null = vigente

type Fundamento = {
  ley: string;          // "LISR" | "LIVA" | "CFF" | "RMF" | "RFA" | "LFPIORPI" | ...
  articulo: string;     // "36"
  fraccion?: string;    // "II"
  chunkId: string;      // → narrative layer (citable text)
};

type FiscalRule = {
  clave: string;        // stable semantic key, e.g. "isr.deduccion.auto.tope_moi"
  tipo: "RATE" | "CAP" | "THRESHOLD" | "EXEMPTION" | "DEPRECIATION" | "OBLIGATION";
  valor: number | boolean | string | Record<string, number>;  // last form = table
  unidad?: "MXN" | "porcentaje" | "UMA" | "dias" | "veces_salario";
  aplicabilidad: Aplicabilidad;
  vigencia: Vigencia;
  fundamento: Fundamento;
  confianza: "OFICIAL" | "BORRADOR_VERIFICAR";   // honest provenance flag
};
```

**Examples** (illustrative — values to verify on ingest):

```ts
{ clave: "iva.tasa.general", tipo: "RATE", valor: 0.16, unidad: "porcentaje",
  aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
  vigencia: { desde: "2014-01-01", hasta: null },
  fundamento: { ley: "LIVA", articulo: "1", chunkId: "…" }, confianza: "OFICIAL" }

{ clave: "iva.exencion.casa_habitacion", tipo: "EXEMPTION", valor: true,
  aplicabilidad: { regimenes: "*", actividades: ["CONSTRUCCION"], tipoPersona: "*" },
  vigencia: { desde: "2014-01-01", hasta: null },
  fundamento: { ley: "LIVA", articulo: "9", fraccion: "II", chunkId: "…" }, confianza: "OFICIAL" }

{ clave: "isr.deduccion.auto.tope_moi", tipo: "CAP", valor: 175000, unidad: "MXN",
  aplicabilidad: { regimenes: "*", actividades: "*", tipoPersona: "*" },
  vigencia: { desde: "2014-01-01", hasta: null },
  fundamento: { ley: "LISR", articulo: "36", fraccion: "II", chunkId: "…" }, confianza: "OFICIAL" }
```

---

## 4. The query interface

The whole contract is two reads. Everything is resolved **as of `fecha`** so the
software is automatically time-correct (pagos provisionales del pasado, anual, etc.).

```ts
type Contexto = {
  regimen: string;
  actividades: Sector[];
  tipoPersona: "PF" | "PM";
  fecha: string;          // ISO; resolves vigencia
};

// Resolve a single rule for a company context. Returns the value + its fundamento,
// or null if no rule applies (engine must handle null explicitly — never assume).
getRule(clave: string, ctx: Contexto): { valor: …; fundamento: Fundamento } | null;

// List all rules of a tipo that apply to the context (e.g. all depreciation rates
// for this sector on this date).
listRules(ctx: Contexto, filtro?: { tipo?: FiscalRule["tipo"] }): FiscalRule[];
```

`getRule` does the applicability + vigencia resolution server-side, so consumers never
re-implement "which version applies." First implementation can be a typed in-repo
table; later it can sit behind an API without changing the signature.

---

## 5. Checks — the 24/7 contador

A `FiscalCheck` is a declarative assertion the **Auditor** evaluates against a
company's normalized data. This is what turns the brain into a continuous contador.

```ts
type FiscalCheck = {
  clave: string;             // "deduccion.combustible.efectivo"
  descripcion: string;       // human summary
  aplicabilidad: Aplicabilidad;
  severidad: "info" | "warn" | "error";
  // Predicado over normalized company facts (CFDIs, movimientos, declaraciones).
  // Returns the offending rows so the Auditor can show + propose a fix.
  evaluar: (data: CompanyData, ctx: Contexto) => Hallazgo[];
  fundamento: Fundamento;
  sugerencia: string;        // proposed alteration, e.g. "reclasificar como no deducible"
};

type Hallazgo = {
  checkClave: string;
  severidad: "info" | "warn" | "error";
  mensaje: string;
  referencias: string[];     // ids of the CFDIs / movimientos involved
  fundamento: Fundamento;
  sugerencia: string;
};
```

**Seed checks** (each cites a rule above — the brain already "knows" these):

- `deduccion.combustible.efectivo` — fuel CFDI paid in cash → no deducible (Art. 27-III).
- `deduccion.restaurante.tope` — restaurant consumo deducted >8.5% (Art. 28-XX).
- `iva.casa_habitacion.trasladado` — CONSTRUCCION sale of casa habitación with 16% IVA
  traslado → likely exempt (Art. 9-II LIVA).
- `deduccion.auto.tope` — vehicle deducted above MOI cap (Art. 36-II).
- `cfdi.inversion.deducido_inmediato` — I0x CFDI expensed in full instead of depreciated
  (ties to the deduction-engine handoff).
- `iva.pue_sin_cobro` — PUE invoice with no matching cobro → IVA causado prematurely.

The Auditor loops: `for each company → resolve Contexto → listChecks(ctx) → evaluar →
persist Hallazgos → surface`. Scheduling is an Auditor concern (cron / queue), **not**
part of this contract — it just needs `listChecks` + `getRule`.

```ts
listChecks(ctx: Contexto): FiscalCheck[];
```

---

## 6. Freshness & vigencia (how the brain "keeps reading laws")

- Rules are **immutable + versioned**. A law change never edits a rule in place; it
  **supersedes** it: set `hasta` on the old version, insert a new one with `desde`.
- `getRule(clave, { …, fecha })` therefore answers correctly for *any* date — past
  audits and present calculations both stay right. This is the "time-travel" the KB
  already supports at the narrative layer (`fecha_vigencia`), lifted to structured data.
- Ingestion pipeline (this workstream): source (DOF / RMF / RFA / leyes) → distill into
  narrative chunks → derive structured rules → diff against current → open superseding
  versions. New or AI-derived values land as `confianza: "BORRADOR_VERIFICAR"` and are
  promoted to `OFICIAL` once checked against source text.

---

## 7. Division of labor

| | Builds | Owns |
|---|---|---|
| **This chat (brain)** | structured rules + checks layer, the `getRule`/`listRules`/`listChecks` interface, ingestion/freshness, sector tagging | *what the law says*, kept current + cited |
| **Other chat (engine)** | computation against the interface, applying results to company CFDIs/movimientos/declaraciones | *how to compute*, presentation, posting |
| **Auditor** (either, TBD) | the scheduled loop that runs checks per company and surfaces Hallazgos | continuous monitoring UX |

### Already shipped (don't duplicate)
- Narrative KB live in prod: LISR/LIVA/CFF + Guía de pagos, `search_fiscal_knowledge`.
  See `docs/FISCAL-KNOWLEDGE-BASE.md`.
- Assistant reasoning rules (CFDI nature, deduction timing, IVA flujo) in
  `src/lib/ai/system-prompt.ts`.
- Deduction-engine spec in `docs/HANDOFF-deduction-engine.md` — its `naturaleza`
  classifier is the first real consumer of `getRule` (depreciation rates, auto cap).

---

## 8. First milestone (sequencing)

1. **Brain:** stand up the structured layer behind the interface in §4 with a starter
   set of `OFICIAL` rules (the §3 examples + the deduction-engine values) — typed table,
   no API yet.
2. **Brain:** add the company **sector profile** (derive `Sector[]` from the RFC's
   actividades económicas, contador-overridable) so `Contexto.actividades` is real.
3. **Engine:** swap any hardcoded constant for a `getRule` call (proves the contract).
4. **Auditor:** implement 2–3 seed checks from §5 end-to-end as the "24/7 contador" proof.

Each step is independently shippable and the interface in §4 stays fixed throughout.
