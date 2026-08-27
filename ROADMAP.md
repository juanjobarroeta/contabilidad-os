# Contabilidad-OS — Product Roadmap

> Living document. Captures the vision (the WhatsApp-native accountant), the
> hard constraints (security, economics) that gate what we're allowed to build,
> and the concrete execution ladder. Update as phases land.

> **Ago 2026 — decisión de ICP:** el despacho es el cliente; los verticales
> (padel, restaurante, purificadora, automotriz) pasan a mantenimiento. La
> cola *comercial* vive en [`docs/GTM-ROADMAP.md`](./docs/GTM-ROADMAP.md)
> («Seis meses a vendible»); este documento sigue siendo la cola técnica.
> Regla permanente: nada se construye para un solo cliente salvo que esté
> pagado y generalice al ICP de despachos.

---

## Estado y cola de ejecución — actualizado 2026-07-04

> Resumen ejecutivo tras el sprint de go-live (PRs #325–#371). Esta sección es
> la fuente de verdad de "qué falta"; las secciones históricas de abajo
> conservan el detalle de diseño.

### Hecho (julio 2026)

- **Go-live hardening completo**: cifrado obligatorio en prod, rate limiting de
  auth, idempotencia de timbrado, guardias de conciliación (incl. 1-a-varios
  con asignación por montos), bitácora de auditoría append-only, baja de
  empresa/cuenta (LFPDPPP), aviso de privacidad y términos con datos reales,
  Sentry + validación de entorno al boot, `next build` en CI, runbook de
  operaciones.
- **Correctitud fiscal**: DIOT 2025 (54 campos) sobre flujo de efectivo,
  tarifa anual PF por ejercicio, coeficiente Art. 14 sobre utilidad fiscal +
  lookback 5 ejercicios, PTU en octavos (Art. 14), IMSS CEAV progresiva
  2023-2030, advertencias de cadena de arrastre rota.
- **Negocio**: Stripe en vivo (Básico $499 / Profesional $1,299 / Despacho
  $299 por empresa), gating real tras bandera, checklist del mes (UI/API/IA),
  dashboard "descargando tus CFDI", **apertura fiscal** (punto de partida con
  procedencia por dato y confirmación firmada).
- **Nómina (pilar 5c) — completo salvo entrega de recibos**: histórico desde
  CFDIs del SAT, validación en paralelo, prefill de quincena, incidencias con
  recálculo, timbrado fiel (ordinaria y extraordinaria TipoNomina=E), hub con
  pestañas + expediente del empleado con acumulados, ajuste anual Art. 97,
  aguinaldo/PTU de un toque, cuotas IMSS/SIPARE con recordatorio.
- **Satélites**: bearer para clientes/facturas/nómina (padel, bartiz, FlotaGob,
  ZionX); conciliación bearer con las mismas guardias.

### Cola de ejecución (en orden)

1. **Seguridad de tokens satélite** — hoy son JWT de usuario completo, 7 días,
   sin revocación, y ya pueden timbrar facturas Y nómina. TTL corto + refresh +
   `jti`/denylist + scope por satélite. *(Subió de prioridad con #364.)*
2. **W3 — Intake de documentos por WhatsApp** (spec 5b abajo): estado de
   cuenta foto/PDF → visión → gate de balance → BankTransaction. El único
   paso manual grande que queda en el ciclo mensual.
3. **Tier 3 — Capa de seguridad para acciones** (spec §4): step-up confirm;
   primer caso "emitir complemento de un toque"; luego "timbrar quincena"
   desde WhatsApp.
4. **Billing fase 2**: sync de cantidad por empresa para Despacho (quantity en
   Stripe), precios anuales (10 meses), mínimo de 10 empresas.
5. **`prisma migrate` baseline** — camino documentado en docs/OPERACIONES.md;
   requiere ventana tranquila y acceso a prod.
6. **Entrega de recibos de nómina** — bloqueado por decisión de proveedor de
   email (recomendado: Resend). Incluye enviar CFDI/PDF al empleado.
7. **Conciliación conversacional** (W3 segunda mitad) — el backend multi-match
   ya existe; falta la superficie en chat.
8. **Menores acumulados**: método opcional Art. 174 RLISR para extraordinarias;
   fase 2 del ajuste anual (aplicar al recibo de diciembre + persistir "presentará
   por su cuenta"); tabla `PagoComplemento` (5a gap 1); export total de datos;
   throttle de IA por usuario; Float→Decimal en dinero (nuevo código primero);
   país/ID fiscal de proveedores extranjeros (DIOT); locking de crons;
   UX de vinculación WhatsApp sin plantilla OTP.

### Manual (dueño, no código)

- Verificar el checkout en vivo → encender `SUBSCRIPTION_ENFORCEMENT_ENABLED`.
- `SENTRY_DSN` en Railway; prueba de restauración de respaldos (runbook);
  verificación Meta Business (desbloquea OTP + digests proactivos);
  `AUTH_SECRET` junto a `NEXTAUTH_SECRET`.
- INPC de junio 2026 vía PR cuando INEGI publique (~10 jul).

---

## WhatsApp capability map — what a contador should handle

> North star: a contador runs their whole month from WhatsApp — asks anything,
> gets nudged before deadlines, sends a statement to reconcile, and one-taps the
> routine actions. The web app is the audit/detail surface; WhatsApp is the
> daily driver.

**Tier 1 — Ask (read-only)** — ✅ mostly built
- Facturación: cuánto facturé/gasté (mes, cliente, proveedor). ✅
- Posición fiscal del mes: IVA a pagar, ISR provisional. ✅ (`query_tax_position`)
- Obligaciones y vencimientos. ✅
- Complementos de pago pendientes — ambas direcciones. ✅
- Anomalías / riesgos de deducción. ✅
- Estado de sincronización SAT ("¿ya bajaron mis 5 años?"). ✅ (`query_sat_sync_status`)
- Conciliación: qué movimientos faltan por conciliar. ✅ (checklist del mes)

**Tier 2 — Documents (inbound)** — 🔜 *(siguiente gran bloque — cola #2)*
- Estado de cuenta (PDF/foto) → parsear (vision + balance-check) → conciliar.
- CFDI / ticket suelto → registrar.
- Voice notes → transcribir → tratar como texto.

**Tier 3 — Act (writes, behind step-up confirmation)** — 🔒 needs safety layer
- Emitir complemento de pago (un toque).
- Timbrar una factura.
- Confirmar/guardar una declaración; marcar obligación como presentada.

**Tier 4 — Proactive (outbound)** — 📣 needs prod WhatsApp + Meta templates
- Digest diario/semanal; alertas (complemento por vencer, IVA estimado antes del 17, CFDI nuevo recibido).

### Accounting depth — design considerations (don't oversimplify)
These are the nuances that separate a real contador tool from a toy. Track them
as we deepen each capability:
- **IVA flujo de efectivo vs devengado** — SAT cobra sobre lo *cobrado/pagado*
  (Art. 1-B), no lo emitido. We already split these (`devengado` vs flujo);
  always be explicit about which we report.
- **IVA acreditable vs trasladado, retenciones** — separate IVA retenido (por
  clientes / a proveedores) from trasladado; don't net naively.
- **Saldos a favor** — IVA saldo a favor se arrastra mes a mes (compensación
  vs devolución vs acreditamiento). Carryover already modeled; surface it.
- **Nómina** — ISR retenido, IMSS obrero/patronal, INFONAVIT, subsidio; nómina
  feeds both ISR retenciones and deducciones. Incidencias (faltas, horas extra,
  finiquitos) change the calc.
- **Timbrar** — CSD + Carta Manifiesto + PAC; cancelaciones (con acuse, plazos),
  sustituciones, relación de CFDIs.
- **ISR provisional Art. 14** — coeficiente de utilidad, PTU, pérdidas
  fiscales, pagos provisionales acumulados. PF vs PM differ (tasa, fechas).
- **Régimen-specific** — RESICO, arrendamiento, actividad empresarial, sueldos
  each have distinct obligations/rates (see régimen map + obligations engine).
- **DIOT, contabilidad electrónica, declaración anual** — distinct artifacts.

---

## 0. Where we are today (built)

- **SAT auto-sync** — Descarga Masiva (CFDIs emitidos/recibidos) via FIEL, with a
  background cron (`/api/cron/sat-sync`), 24h request reuse to respect SAT quotas,
  and incremental period tracking (`SatSyncRequest`).
- **CFDI model** — `Invoice` (tipo INGRESO/EGRESO/TRASLADO/NOMINA/PAGO, metodoPago
  PUE/PPD, formaPago, uuid, status). PAGO/REP CFDIs stored as `Invoice` rows.
- **Banking** — `BankAccount` + `BankTransaction` (reconciliation status
  UNMATCHED/MATCHED/IGNORED), Belvo open-banking integration, and a statement
  parser (`bank-parser.ts`) for CSV / OFX-QFX / SpreadsheetML.
- **Complemento de pago (emission)** — `/api/facturas/complemento-pagos` detects
  PPD invoices with matched bank transactions and emits REPs via Facturapi.
- **AI read tools** — `tool-executor.ts` + 10 read-only tools (query_invoices,
  query_bank_transactions, query_tax_declarations, query_dashboard_kpis,
  query_customers, query_employees, query_obligations, categorize_transaction,
  suggest_reconciliation_match, analyze_anomalies).
- **Identity/authz** — `Company`, `User`, `CompanyMember`, `Despacho` +
  `getEffectiveCompanyMembership()` (most-permissive role across direct + despacho).
- **Staging** — Railway staging setup documented (`STAGING.md`).

---

## 1. The vision

A **WhatsApp-native accountant**. A client or a contador texts a number; the
system knows who they are and which company they mean, answers questions, sends
proactive alerts, ingests documents, and (eventually, behind a safety layer)
takes fiscal actions. Both audiences are first-class:

- **End clients** — one phone → usually one company.
- **Contadores** — one phone → many companies (the wedge; one firm amortizes cost
  across all its client companies).

---

## 2. Capability pillars

Each pillar is tagged with a **risk tier**. Tiers A/B/E are safe over WhatsApp;
C/D/F require the safety layer (§4). Secrets never touch WhatsApp at all.

| Pillar | Description | Risk | Depends on |
|--------|-------------|------|------------|
| **A — Q&A (read-only)** | "¿Cuánto facturé este mes?" Uses existing read tools in-process. | Low | — |
| **B — Proactive alerts** | New CFDI received; complemento needed; IVA/ISR running estimate; tax-calendar deadlines. Outbound, no action required. | Low | SAT sync, scheduler, notif table |
| **C — Document intake** | User sends a bank statement / receipt photo or PDF → parse → stage. | Med | Vision extraction + validation |
| **D — Reconciliation** | Conversational matching of bank movements to CFDIs. | Med | Pillar C, safety layer |
| **E — Guidance** | "¿Qué necesito para mi declaración de mayo?" Pure reasoning over existing data. | Low | — |
| **F — Actions / writes** | Emit complemento, stamp invoice, submit reconciliation, file declaración. | High | Safety layer (§4) |

**Group chats (contador + client + bot):** aspirational, **blocked** by platform
limits — the WhatsApp Business Platform (Cloud API / Twilio) is built around 1:1
business↔customer threads, not bots-in-groups. Realistic version: bot DMs each
party; contador gets a separate "manage clients" view.

---

## 3. Execution ladder

### W0 — Channel + identity + read-only Q&A (Pillar A) — ✅ en producción
- `POST /api/whatsapp/webhook` (Twilio), **verify `X-Twilio-Signature`** on every request.
- **New tables:** `WhatsappLink` (phoneE164, userId, verifiedAt, activeCompanyId),
  `WhatsappConversation`, `WhatsappMessage` (history + `pendingAction` slot for later).
- **Linking flow:** in-app "Vincular WhatsApp" → 6-digit code over WhatsApp → verify.
  Caller ID is never trusted on its own.
- **Company disambiguation:** 1 company → auto; many → ask + remember `activeCompanyId`,
  allow switching. Enforced via `getEffectiveCompanyMembership`.
- **Agent:** reuse `tool-executor.ts` in-process; WhatsApp-specific plain-text system
  prompt (no markdown tables), MXN formatting, explicit "read-only for now."
- **Gated on staging** (webhook needs a public HTTPS URL — staging is the test bed).

### W1 — Daily digest + alerts (Pillar B) — ✅ en producción (briefing, digests, dedupe)
- Scheduler (sibling to `/api/cron/sat-sync`) → detectors → **notifications/dedup table**
  → one batched daily digest (not per-event spam — economics + UX agree).
- First detectors: new CFDI received, **complemento needed** (§5a), IVA/ISR estimate,
  tax-calendar deadlines.

### W2 — Guidance (Pillar E) — ✅ checklist del mes + KB fiscal (profundizar vigencia pendiente)
- Declaración checklists + "what's missing" + estimates. Smarter Q&A, no writes.
  Can ship early — it's low risk.
- **Fiscal knowledge base (agente fiscal)** — RAG over Mexican tax sources (leyes
  vigentes, RMF, criterios SAT, DOF) so guidance is *cited* and *version-aware*
  instead of relying on hardcoded prompt prose. Design doc:
  `docs/FISCAL-KNOWLEDGE-BASE.md`. The hard part is vigencia (temporal versioning).

### W3 — Document intake + reconciliation (Pillars C, D) — 🔜 cola #2 y #7
- Bank-statement-via-WhatsApp (§5b) and conversational reconciliation.

### W4+ — Actions (Pillar F) — 🔒 cola #3 (capa de seguridad primero)
- One-tap complemento emission, then broader writes — each behind the safety layer.

---

## 4. Security — hard constraints (non-negotiable)

The data behind the door is unusually sensitive: e.firma (FIEL), CSD certs +
passwords, SAT CIEC password, bank data, and RFC/personal data under **LFPDPPP**.

1. **WhatsApp is a notification + low-trust input channel, never a vault.** Secrets
   (CIEC, CSD password, e.firma) are never sent or accepted over WhatsApp. If a step
   needs a secret, hand off to an in-app link.
2. **Caller ID is not identity.** Verified link only. Assume SIM-swap is possible.
3. **Step-up auth for any write.** "Sí" in chat is intent, not authorization. Money/
   fiscal actions require an in-app confirm or one-time code.
4. **Secrets encrypted at rest** (envelope/KMS), never logged, redacted in agent context.
5. **Full audit log** of every action taken via the channel (who, company, when, what).
6. **Authorization scoped to company membership** (`getEffectiveCompanyMembership`), fail-closed.
7. **Data minimization in prompts** — send the model only what the question needs; mask
   RFCs/account numbers where possible. Don't persist raw statement images past extraction.

Mental model: **A, B, E are safe over WhatsApp. C, D, F need the safety layer.
Secrets never touch WhatsApp.**

---

## 5. Feature specs (grounded in current data model)

### 5a. Complemento de pago — proactive detection

**Existing:** emission path works (`/api/facturas/complemento-pagos`). PAGO/REP CFDIs
are `Invoice` rows; the parent is referenced by a **string in `notas`** — no FK.

**Gap 1 — fix the link (data model first).** A `notas` string can't represent the
real shape: one PPD invoice can have **many parcialidades**, each needing its own REP
with a running balance. Add a `PagoComplemento` link row: `parentInvoiceId`,
`pagoInvoiceId`, `numParcialidad`, `importePagado`, `saldoAnterior`, `saldoInsoluto`,
`fechaPago`.

**Gap 2 — bidirectional detector (cron, runs after sync + reconciliation):**

*Direction 1 — you owe a complemento (emitidos):*
```
For Invoice tipo=INGRESO, metodoPago=PPD, status=STAMPED:
  total_paid   = Σ matched incoming BankTransactions
  rep_covered  = Σ importePagado across linked PAGO REPs
  if total_paid > rep_covered:
     ALERT "Cobraste $X de factura #123, falta emitir complemento"  (actionable)
```

*Direction 2 — vendor owes you one (recibidos) — deduction-risk:*
```
For Invoice tipo=EGRESO, metodoPago=PPD:
  if matched OUTGOING BankTransaction exists (you paid)
  but no received tipo=PAGO CFDI references it:
     ALERT "Pagaste a PROVEEDOR, falta su complemento — riesgo para tu deducción"
```

**Edge cases:** PUE never needs a complemento; complemento is **due by the 5th of the
month after payment** (the alert has a real deadline); handle cancellations; net partial
payments against cumulative `saldoInsoluto`, not the full total.

### 5b. Bank statement via WhatsApp

**Existing:** `bank-parser.ts` (CSV/OFX/SpreadsheetML), Belvo open banking, staging as
`BankTransaction`, and `suggest_reconciliation_match`. The staging + reconciliation tail
is done.

**The real gap:** over WhatsApp people send a **photographed/forwarded PDF estado de
cuenta**, which the parser doesn't handle. New work = an extraction stage in front:

1. **Media intake:** Twilio media URL → download → sniff type. CSV/OFX/SpreadsheetML →
   existing parser.
2. **PDF/image → Claude vision** → structured movimientos JSON.
3. **Validation gate (critical):** verify `opening_balance + Σ movements = closing_balance`.
   Reconciles → stage with confidence; mismatch → flag rows and ask, never ingest blind.
4. **Stage → existing `BankTransaction`** (add `WHATSAPP` source) → reconciliation unchanged.

**Notes:** Belvo is the better path wherever supported — "send your statement" is the
**fallback** for banks/users not on open banking. Statement images are high-sensitivity:
don't persist raw images past extraction.

### 5c. Nómina — from calculator to payroll system of record

Nómina is a first-class pillar, not an accessory: it feeds ISR retenciones,
IMSS/SUA, PTU (Art. 14 eighths in provisionales), and it's a top reason SMBs
pay for software at all. Ladder:

1. **Historic import (onboarding magic)** — stamped NOMINA CFDIs from the SAT
   sync populate PayrollRun/PayrollItem as read-only SAT-origin history, deduped
   by uuid against app-emitted runs. A company that onboards sees its payroll
   past without capturing anything. *(✅ #360.)*
2. **Recurring quincenas** — "iniciar desde la quincena anterior": prefill
   roster/salaries/recurring concepts, advance the period, recalculate taxes
   through calc-nomina (never copy computed taxes). *(✅ #360.)*
3. ✅ (#367) **Incidencias flow** — faltas, horas extra, incapacidades, vacaciones as a
   quick capture step between prefill and stamp; finiquitos/liquidaciones with
   the Art. 50/162 calculators already in `nomina/finiquito.ts`.
4. ✅ parcial (#368 SIPARE, #370 ajuste anual; variances EMA/EBA pendiente) **Cumplimiento loop** — SUA/IDSE reconciliation (export exists; deepen
   variances view), CEAV progressive table already correct 2023-2030, annual
   declaración informativa tie-ins, ISN estatal awareness.
5. 🔒 (espera Tier 3) **WhatsApp surface** — "¿cuánto de nómina este mes?", pre-stamp reminder
   T-1 (exists), one-tap "timbrar quincena" once Tier-3 actions land (never
   auto-stamp: human confirms, always).

---

## 6. Economics

Two cost centers stack per interaction:

- **WhatsApp/Meta per-message pricing** (2025 per-message model, by category): *service*
  (user-initiated, 24h window) cheapest/often free; *utility* templates (proactive alerts)
  a few cents each in MX; *marketing* most expensive. → **Pillar B is the cost driver**
  (outbound × users × events). Reactive Q&A is cheap.
- **Claude tokens** per turn — controlled with **prompt caching** (system prompt + company
  context) + tool-round cap. A typical Q&A is fractions of a cent to low cents.

**Implications:**
- **Bound the alerts** — digest/batch collapses N utility messages into 1 (why W1 is a digest).
- **Pricing fit** — per-company SaaS subscription; WhatsApp as a **premium tier**; contadores
  are the wedge (one firm × many companies amortizes cost).
- **Cost guardrails as features** — per-company rate limits, max tool rounds, alert dedup,
  monthly spend cap so a runaway loop can't rack up Meta + Claude charges.

---

## 7. Market (rough sizing)

- **Mexico fiscal base (June 2025):** ~88.6M active taxpayers — **2.5M personas morales**
  (companies) + ~84M personas físicas. Every stamped CFDI and PPD complemento is mandatory,
  so the pain is structural, not optional.
- **Contadores / firms:** ~15,000 small accounting firms (0–10 employees) + ~1,475 mid
  (11–50) per DENUE (May 2025); ~23,000 organized in IMCP (≈4% of practitioners).
- **Comparables:** Alegra (SME accounting SaaS, LatAm), CONTPAQi (incumbent desktop),
  Konfío (SME fintech, reached unicorn / ~$1.3B on lending), Clara (spend management).
  The lane here — **AI + WhatsApp-native compliance copilot** — is adjacent to all and
  owned by none.

See chat thread for the full TAM/SAM/SOM and valuation reasoning.

---

## 8. Open decisions

- Twilio vs Meta Cloud API (leaning Twilio for sandbox speed; revisit at scale on cost).
- Opt-in / template approval flow for proactive (utility) messages.
- Whether `PagoComplemento` is a new table or a self-relation on `Invoice`.
- Vision model statement-extraction accuracy bar + the balance-check tolerance.
