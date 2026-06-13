# Fiscal update cadence — keeping the brain fresh

The brain is only as good as its freshness. This note catalogs **what the brain
depends on, how often it changes, and how it gets refreshed**. The machine-
readable source of truth is `src/lib/fiscal/sources.ts` (`FUENTES`); this doc
explains it and the cron strategy.

## Two halves, two refresh paths

| Half | Where | Refreshed by |
|---|---|---|
| **Narrativa** (KB) | Postgres `FiscalDocument`/`FiscalChunk` (pgvector) | **Ingesta** — re-fetch + chunk + embed + version (`src/lib/fiscal-kb`). Idempotent (hash); only re-embeds on change. |
| **Reglas** (valores) | git `src/lib/fiscal/rules/catalog.ts`, `tarifas.ts` | **PR revisado** — every number lands in code review with `vigencia` + `verificado`. |

## Cadence

| Cadencia | Fuentes | Acción |
|---|---|---|
| **Diaria** | Tipo de cambio FIX (Banxico SF43718) | **Informativo (hecho)**: `fetchTipoCambioFix` en vivo + cache 6 h, mostrado en `/cumplimiento`. Sin fluctuación cambiaria aún |
| **Mensual** | INPC (valores de INEGI; cotejo contra Banxico SP1) | **Cotejo auto (hecho)**: cron semanal `cotejo-fiscal` valida vs Banxico. Cargar meses nuevos al seed sigue manual |
| **Anual** (dic-feb) | RMF, RFA, Tarifas ISR, UMA (1-feb), Salario mínimo (1-ene), **ISN por estado** | Revisión de cierre/apertura de ejercicio |
| **Por publicación** (DOF) | LISR, LIVA, CFF, LIEPS, guías SAT, catálogos CFDI | Re-ingesta periódica detecta el cambio |

## Auto vs manual

- **`auto`** — el cron re-ingesta sin intervención: **LISR, LIVA, CFF, LIEPS**
  (texto vigente de diputados.gob.mx) y las **guías SAT** (GUIA-PAGOS,
  GUIA-CFDI-GLOBAL). Esto lo hace `.github/workflows/fiscal-kb-refresh.yml`
  (semanal) vía `POST /api/admin/fiscal-ingest`. Como la ingesta es idempotente,
  re-correr es barato: sólo re-embebe cuando el texto cambió.
- **`semiauto`** — el cron puede dispararla pero requiere insumo o revisión:
  **RMF** (PDF del DOF, que bloquea bots → subir con `--file`), **Tarifas ISR**
  y **Depreciación** (PR contra la fuente), **INPC / Tipo de cambio** (leer la
  serie publicada).
- **`manual`** — captura/PR humano: **ISN por estado** (Leyes de Ingresos
  estatales), **UMA**, **salario mínimo**, **catálogos SAT**.

## Cron strategy

1. **KB auto-refresh (semanal)** — `fiscal-kb-refresh.yml` re-ingesta las fuentes
   `fuentesAuto()`. Detecta reformas a leyes/guías a los pocos días de publicarse.
2. **Recordatorio de cierre de ejercicio (anual)** — *pendiente*: un job que en
   dic-ene levante un aviso por cada fuente `anual` (`fuentesPorCadencia("anual")`)
   para verificar/actualizar tasas (ISN, tarifas, UMA, salario mínimo, RMF).
3. **Factores externos (diaria/mensual)** — el **cotejo del INPC** corre semanal
   (`cotejo-fiscal.yml`) contra **Banxico SIE serie SP1** (INEGI no expone el INPC
   en su API de indicadores; sólo UMA). El **FIX** (Banxico `SF43718`) se lee en
   vivo como dato informativo. Ambos usan `BANXICO_TOKEN`. *Pendiente*: cargar
   automáticamente meses nuevos del INPC al seed; fluctuación cambiaria (Art. 8 LISR).

> El backlog de fuentes identificadas pero aún no cableadas es
> `fuentesPendientes()`. Conforme se cablean, cambian de `pendiente` a `activo`.

## Discipline

- Las **reglas** nunca se editan en sitio: se cierra la `vigencia` anterior y se
  agrega una versión nueva (así `getRule(..., {fecha})` responde correcto para
  cualquier periodo, incluidas auditorías de años pasados).
- Toda tasa nueva entra como **`verificado: false`** hasta cotejarse contra la
  fuente primaria.
