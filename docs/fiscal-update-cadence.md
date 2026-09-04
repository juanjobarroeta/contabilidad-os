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
| **Anual** (dic-feb) | RMF, RFA, Tarifas ISR, **Multas CFF (Anexo 5)**, **Recargos (LIF)**, UMA (1-feb), Salario mínimo (1-ene), **ISN por estado** | **Retrieval como PR (hecho)**: `valores-fiscales.yml` descarga Anexo 5 / Anexo 8 / LIF, regenera `src/lib/fiscal/datos/*.json` y abre un PR draft; el cotejo semanal confirma multas, tarifas, recargos y UMA contra la fuente. ISN y subsidio siguen por PR a mano |
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

## Capa de valores (multas, tarifas, recargos, UMA, salario mínimo)

Los VALORES que el copiloto y los cálculos usan viven en código versionado:

| Dataset | Archivo | Fuente oficial | Cómo entra | Cómo se coteja |
|---|---|---|---|---|
| Multas y cantidades del CFF | `src/lib/fiscal/datos/multas-cff-<Y>.json` | Anexo 5 RMF (PDF en el minisitio del SAT) | `npm run fiscal:valores` → PR (`valores-fiscales.yml`) | `cotejo-fiscal` fila por fila |
| Recargos (prórroga, mora, plazos) | `src/lib/fiscal/datos/recargos-<Y>.json` | LIF del ejercicio (Cámara de Diputados); mora = prórroga × 1.5 (Art. 21 CFF) | ídem | ídem |
| Tarifas ISR mensual / anual | `src/lib/fiscal/tarifas.ts` (a mano) | Anexo 8 RMF | PR a mano | `fiscal:valores --strict` y `cotejo-fiscal` fila por fila |
| Subsidio al empleo | `tarifas.ts` | Decreto (DOF) | PR a mano | — |
| UMA | `rules/catalog.ts` (`uma.valor`) | Boletín anual del INEGI (PDF, sin token); API de indicadores opcional (`INEGI_TOKEN`) | PR a mano | `cotejo-fiscal` y `fiscal:valores --strict` |
| Salario mínimo | `rules/catalog.ts` | CONASAMI (gob.mx bloquea bots) | PR a mano | — |

El copiloto los consulta con la tool `get_valor_fiscal` (`src/lib/fiscal/valores.ts`)
y tiene prohibido decir montos de memoria; el eval mide «valor correcto» con
las preguntas `v01…v08`.

Parsers puros y probados con los PDF reales de 2026: `src/lib/fiscal/fuentes/`
(`anexo5.ts`, `anexo8.ts`, `lif.ts`; `sat-anexos.ts` localiza el PDF por la
fecha del DOF en el nombre del archivo; una URL explícita —env `SAT_ANEXO5_URL`,
`SAT_ANEXO8_URL`, `LIF_URL` o input del workflow— gana siempre).

## Discipline

- Las **reglas** nunca se editan en sitio: se cierra la `vigencia` anterior y se
  agrega una versión nueva (así `getRule(..., {fecha})` responde correcto para
  cualquier periodo, incluidas auditorías de años pasados).
- Toda tasa nueva entra como **`verificado: false`** hasta cotejarse contra la
  fuente primaria.
