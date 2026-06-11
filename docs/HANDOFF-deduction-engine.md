# Handoff: `usoCfdi` → deduction-treatment engine

> For the tax-engine workstream. Goal: make received CFDIs deduct **correctly by
> nature** instead of being lumped into "compras/deducciones." Today the nature
> is *recorded* (`usoCfdi`) but not *acted on*, so an activo-fijo purchase and a
> regular expense are treated the same in the ISR math.

## The key fact

Every `Invoice` already stores **`usoCfdi`** (SAT Uso del CFDI, from the XML).
That field is the inventory-vs-activo-fijo signal:

| `usoCfdi` | Naturaleza | Deduction treatment | Fundamento |
|---|---|---|---|
| **G01** Adquisición de mercancías | Inventario | **Costo de lo vendido** al vender | Art. 39 LISR |
| **I01–I08** Inversiones (I03 = Equipo de transporte, I04 cómputo, I08 maquinaria…) | Activo fijo | **Depreciación** (deducción de inversiones) + topes | Art. 31, 34, 36 LISR |
| **G03** Gastos en general (and the import default) | Gasto | Deducible en el periodo (requisitos Art. 27) | Art. 25/27 LISR |
| **S01** Sin efectos fiscales | No deducible | — | — |

## Current state (what exists / what's missing)

- `prisma/schema.prisma` → `model Invoice` (~L416): has `tipo`, `usoCfdi`,
  `overrideCuenta`. **No** `naturaleza` / deduction-treatment field.
  `InvoiceItem.claveProdServ` (~L536) is available to detect vehicles.
- `src/lib/facturas/import-cfdi.ts:90` → on SAT import, `usoCfdi` defaults to
  **`"G03"`** when the XML lacks it (so unclassified ⇒ treated as expense).
  `src/app/api/facturas/upload-cfdi/route.ts:118` hardcodes `"G03"`.
- `src/lib/declaracion-anual.ts:23` → `depreciacion` is a **manual input**
  (`// Manual input (fixed assets)`). No automated schedule, no auto cap, **no
  COGS** engine.
- `src/lib/accounting/postings.ts` → posts to SAT accounts but doesn't branch on
  inventario/activo-fijo for *timing*.
- `src/lib/impuestos.ts` → tax position / ISR provisional; deductions don't
  distinguish nature.

## Proposed build

1. **Classifier** (`src/lib/fiscal/clasificar-cfdi.ts` or similar):
   `usoCfdi` (+ `overrideCuenta` / `claveProdServ`) →
   `Naturaleza = GASTO | INVERSION | INVENTARIO | SIN_EFECTOS`. Add a
   `naturaleza` field on `Invoice` (derived, contador-overridable).
   **Don't trust the G03 default** — flag G03 CFDIs whose `claveProdServ` looks
   like an asset for review.
2. **Inversiones register**: per activo-fijo CFDI store MOI, fecha de
   adquisición, tasa (Art. 34: autos 25%, cómputo 30%, mobiliario 10%…), tope
   aplicado. Compute **monthly depreciation** for pagos provisionales (Art. 14)
   and the anual.
3. **Auto cap** (Art. 36-II): automóviles MOI deducible ~**$175,000**
   (~$250k eléctrico/híbrido). ⚠️ **Camioneta de CARGA/pickup is NOT "automóvil"**
   → no cap, depreciate as vehículo. Decide via `claveProdServ` + maybe a manual
   flag.
4. **Costo de lo vendido** (Art. 39) for `INVENTARIO` — needs inventory tracking
   (harder; can be phase 2).
5. **Wire in**: `impuestos.ts` (ISR provisional deducciones) and
   `declaracion-anual.ts` (replace manual `depreciacion` with computed).
   **Critical: an `INVERSION` CFDI must NOT enter immediate "compras/gastos" —
   only its depreciation does.** Avoid double-counting.

## Gotchas

- **IVA ≠ ISR timing for assets.** IVA acreditable on an activo fijo is immediate
  (al pagarse, flujo — Art. 1-B / 5 LIVA), even though the ISR deduction spreads
  over years via depreciation. Don't conflate the two.
- ISR income is **devengado** (Art. 17/18); IVA is **flujo** (causa al cobro,
  Art. 1-B/11). PUE declares cobro; PUE-sin-cobro ⇒ cancelar/sustituir a PPD
  (Art. 29-A CFF).
- Depreciation uses MOI con **actualización por INPC**; partial first-year rules.

## Already done (don't duplicate)

- **Fiscal KB is live in prod**: LISR (236 art), LIVA (60), CFF (401), Guía de
  pagos — queryable via the `search_fiscal_knowledge` tool. All articles above
  are retrievable for citations. See `docs/FISCAL-KNOWLEDGE-BASE.md`.
- **Assistant reasoning rules** for CFDI nature / deduction timing / IVA flujo
  are in `src/lib/ai/system-prompt.ts` (PR #54). The engine should mirror this
  logic in code.
- Fiscal-KB code lives under `src/lib/fiscal-kb/` — separate from the engine's
  `src/lib/fiscal/`, so no collision there.
