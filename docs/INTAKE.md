# Intake & Prioritization

Cada pedido de cliente que llega por WhatsApp o Zoom se convierte en un issue de
GitHub **puntuado y deduplicado**, sin que Juan sea el paso de
transcripción/triage. El sistema produce una lista rankeada; **un humano
aprueba** — automatizar la decisión de qué construir es un no-objetivo.

## Adaptaciones respecto al spec original

El spec de referencia asumía un repo nuevo con WhatsApp Cloud API (Meta). Este
build lo integra al stack existente, que cambia tres cosas:

| Spec | Aquí | Por qué |
|---|---|---|
| WhatsApp Cloud API (Meta) + verificación de negocio | **Tap del webhook Twilio existente** (`/api/whatsapp/webhook`) | El canal ya existe, con firma verificada, dedupe por `MessageSid` y transcripción de notas de voz (Whisper). Cero infra nueva, cero semanas de verificación de Meta. |
| Railway cron services (3 entradas) | **Scheduler en-proceso** (`cron-scheduler.ts`) con ritmo adaptativo | Es el patrón del repo; sin `INTAKE_ENABLED=1` cada tick es un no-op de una comparación. |
| Tabla SQL a mano | **Prisma** (modelos `RawIntake`, `IntakeContact`, `IntakeTranscript`, `CandidateAsk`, `AskEmbedding`, `IntakeScoreSnapshot`) + migración | Convención del repo; pgvector ya estaba instalado (knowledge base fiscal). |

Todo lo demás sigue el spec: capa cruda append-only, extracción conservadora
con Claude, compuerta Telegram, GitHub Issues + Projects v2, scoring semanal
con `core_multiplier`.

## Arquitectura

```
WhatsApp (Twilio webhook, ya existente)      Zoom (recording.completed)
        │ tap fire-and-forget                        │ POST /api/ingest/zoom
        ▼                                            ▼
                     RawIntake  (append-only, UNIQUE(source, externalId))
                          │
        [cron intake-transcribe]  Zoom → Deepgram nova-2 (keywords fiscales,
                          │       diarización) o Whisper como fallback
                          ▼
                    IntakeTranscript
                          │
        [cron intake-extract]  Claude — JSON estructurado, conservador;
                          │    WhatsApp agrupado por contacto (pausa 30 min,
                          │    tope 6 h); dedupe título + embeddings pgvector
                          ▼
                    CandidateAsk (PENDING)
                          │
        [cron intake-digest]  tarjetas Telegram 08:00/18:00 MX
                          │   [✅ Crear] [🔀 Merge] [✏️ Editar] [❌ Descartar]
                          ▼   (callback → /api/telegram/callback)
                  GitHub Issue (+ Projects v2 board opcional)
                          │
        [cron intake-score]  lunes 06:00 MX — score → campo del board +
                             digest top-10 con "qué se movió"
```

`score = ((mrr_at_risk + mrr_unlocked) * confidence / effort_days) * core_multiplier`

`core_multiplier = 3.0` si el producto cae en el motor compartido
(ContabilidadOS), `1.0` para satélites. Es el punto de la fórmula: empuja el
trabajo del motor por encima del satélite, que es lo primero que se erosiona
bajo presión de clientes. El scoring **propone**; nunca escribe Status.

## Variables de entorno

Todo es opt-in. Sin configurar, el deploy es inerte.

| Variable | Qué habilita |
|---|---|
| `INTAKE_ENABLED=1` | Master switch: tap de WhatsApp, ingest de Zoom y los 4 crons. |
| `ZOOM_WEBHOOK_SECRET_TOKEN` | Webhook `/api/ingest/zoom` (Secret Token de la app S2S de Zoom). |
| `DEEPGRAM_API_KEY` | Transcripción primaria (nova-2 + vocabulario). Sin ella cae a Whisper (`OPENAI_API_KEY`, ya en el stack). |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | Bot de aprobación y digests. |
| `TELEGRAM_WEBHOOK_SECRET` | Auth del callback (`setWebhook` con `secret_token`). |
| `INTAKE_GITHUB_TOKEN` / `INTAKE_GITHUB_REPO` | Creación de issues (`owner/repo` default). |
| `INTAKE_GITHUB_REPO_<PRODUCTO>` | Override de repo por producto (p. ej. `INTAKE_GITHUB_REPO_AUTOMOTRIZ`). |
| `INTAKE_GITHUB_PROJECT_ID` | Node ID del Projects v2 board (agrega issues + scoring). |
| `INTAKE_GITHUB_SCORE_FIELD_ID` | Field ID del campo numérico `Score` del board. |
| `AI_EXTRACT_MODEL` | Override del modelo de extracción (default: `AI_CHAT_MODEL`). |

## Setup

1. **Migración**: se aplica sola en deploy (`scripts/deploy-db.mjs`). Incluye
   `CREATE EXTENSION IF NOT EXISTS vector`.
2. **Zoom**: app Server-to-Server OAuth, scopes `recording:read:admin`; evento
   `recording.completed` → `https://<app>/api/ingest/zoom`. El endpoint
   contesta el reto `endpoint.url_validation` automáticamente. Activa la
   grabación en la nube. **Convención de nombres de reunión** (atribución
   gratis): `[CONTABILIDADOS] Despacho Reyes — onboarding`.
3. **Telegram**: crea el bot con @BotFather, obtén el chat id del canal
   privado, y registra el webhook:
   `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<app>/api/telegram/callback&secret_token=<TELEGRAM_WEBHOOK_SECRET>"`
4. **Projects v2** (opcional, fase 5): un board con campos `Score` (number),
   `Effort (days)` (number), `MRR at risk` (number), `MRR unlocked` (number),
   `Confidence` (number 0–1), `Core?` (single select Yes/No). IDs con GraphQL:
   ```graphql
   query { node(id: "<PROJECT_ID>") { ... on ProjectV2 {
     fields(first: 30) { nodes { ... on ProjectV2FieldCommon { id name } } } } } }
   ```
5. **Vocabulario**: `config/vocabulary.es-mx.json` — adiciones por PR normal.

## Operación

- **Silencio = sano.** El digest matutino avisa si `RawIntake` lleva >24 h sin
  eventos (webhook caído = fallo silencioso nº1).
- Los crons corren solos (scheduler en-proceso). A mano:
  `POST /api/cron/intake-digest?force=1` (salta la ventana horaria),
  `POST /api/cron/intake-score?force=1` (ídem; el snapshot único por semana
  evita corridas dobles). Auth: header `x-cron-secret`.
- **Deriva de extracción**: vigila la razón aprobado/descartado en el chat de
  Telegram. Si el rechazo sube, el prompt (en `src/lib/intake/extract.ts`)
  necesita trabajo. El botón ✏️ es el termómetro: si dejas de usarlo, el
  prompt está bien.
- **Re-extracción histórica**: `RawIntake` nunca se borra. Para re-correr con
  un prompt mejor: `UPDATE "RawIntake" SET "processedAt" = NULL WHERE …` (y
  borrar los `CandidateAsk` pendientes derivados, si aplica).
- **Graduación** (futuro): con ~200 asks revisados, mide precisión por
  producto/kind y auto-aprueba los buckets >90% (status `AUTO_APPROVED` ya
  existe en el enum; el logging al canal se mantiene).

## Límites conocidos / siguientes pasos

- El "Merge #123" fusiona el estado local (`MERGED` + `dedupeOf`); no comenta
  en el issue destino todavía.
- El scoring lee/escribe el board, pero `Effort`, `MRR` y `Core?` se capturan
  a mano en GitHub — como manda el spec (estimación humana).
- Fixtures de evaluación del prompt (spec §5): pendiente juntar ~10
  transcripciones reales etiquetadas antes de iterar el prompt.
- Si el volumen pasa ~500 asks/semana: cola real y clasificador barato de
  primer paso (spec §13).
