# Contabilidad-OS

**El despacho opera el mes completo de cada cliente en un solo lugar:**
**SAT → conciliación → declaración → nómina → libro mayor.**

Contabilidad-OS es una plataforma de contabilidad y cumplimiento fiscal para
despachos contables en México. Descarga los CFDI directamente del SAT (FIEL),
concilia contra bancos, calcula y documenta las declaraciones con papeles de
trabajo, timbra facturas y nómina, y lleva el libro mayor — el ciclo cerrado
que ningún competidor cloud ofrece completo.

## El producto en una pasada

| Pilar | Qué hace |
|---|---|
| **Sincronización SAT** | Descarga masiva de CFDI (emitidos y recibidos) vía FIEL, con historial de 5 ejercicios al dar de alta una empresa. |
| **Bancos** | Open banking (Belvo) + parser de estados de cuenta; mesa de conciliación con auto-conciliación diaria de alta confianza. |
| **Impuestos** | IVA en flujo de efectivo (Art. 1-B), ISR provisional Art. 14 con coeficiente y lookback de 5 ejercicios, DIOT 2025 (54 campos), papeles de trabajo por declaración. |
| **Nómina** | Corridas con prefill, incidencias, finiquitos (Art. 50/162), timbrado, IMSS/SIPARE, ajuste anual Art. 97, expediente del empleado. |
| **Facturación** | Timbrado CFDI 4.0 (PAC), borradores, recurrentes, complementos de pago con detección proactiva de REPs faltantes. |
| **Contabilidad electrónica** | Catálogo, balanza, pólizas, cierre y entregables XML para el SAT. |
| **Cumplimiento** | Screening EFOS/69-B diario, opiniones de cumplimiento, hallazgos accionables, bitácora de auditoría append-only. |
| **IA** | Agente por WhatsApp (consultas de sólo lectura, briefings, notas de voz) y servidor MCP para consultar la contabilidad desde Claude/ChatGPT. |

Multi-empresa y multi-usuario de origen: `Despacho` → empresas → roles por
miembro. El despacho es el cliente; una firma amortiza el costo entre todas
sus empresas.

## Stack

Next.js 15 (App Router) · React 19 · Prisma + PostgreSQL · Railway ·
Sentry · Stripe · Twilio (WhatsApp) · Facturapi (PAC) · Belvo ·
Anthropic (agente y visión). PWA con notificaciones push.

## Desarrollo

```bash
nvm use            # Node 20+
npm install
npm run dev        # requiere .env — ver .env.example
npm test           # unit (vitest)
npm run test:db    # integración contra Postgres
```

Convenciones: una tarea = una rama = un PR (sin batches); en el checkout
compartido se trabaja con un worktree por sesión. CI corre `next build` y
las suites en cada PR.

## Mapa de documentación

- [`ROADMAP.md`](./ROADMAP.md) — visión de producto y cola técnica.
- [`docs/GTM-ROADMAP.md`](./docs/GTM-ROADMAP.md) — plan comercial: seis meses a vendible.
- [`docs/OPERACIONES.md`](./docs/OPERACIONES.md) — runbook de operación.
- [`docs/security/PLAN.md`](./docs/security/PLAN.md) — plan Bóveda (hardening) y estado.
- [`docs/API-TOKENS.md`](./docs/API-TOKENS.md) — tokens de API para satélites.
- [`docs/INTEGRATION-GUIDE-SATELLITE-APPS.md`](./docs/INTEGRATION-GUIDE-SATELLITE-APPS.md) — arquitectura hub-satélite.
- [`STAGING.md`](./STAGING.md) — entorno de staging.

## Seguridad

Los datos detrás de la puerta son inusualmente sensibles (e.firma, CSD, CIEC,
bancos, datos personales bajo LFPDPPP). Reglas duras: secretos cifrados en
reposo y nunca por WhatsApp; identidad verificada (el caller ID no es
identidad); step-up para cualquier escritura; bitácora de auditoría de toda
acción; autorización fail-closed por membresía de empresa. Historial de git
escaneado con gitleaks (limpio); aislamiento de tenants cubierto por tests
estáticos sobre todas las rutas y tests de `authz` contra Postgres real.
