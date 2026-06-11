# ContabilidadOS — Handoff (estado fiscal y operativo)

_Última actualización: 2026-06-11_

Este documento es el punto de partida para una sesión nueva. Resume qué está
hecho, dónde vive la lógica crítica, y qué falta — en orden de prioridad.

---

## 1. Motor fiscal — mapa de archivos

| Archivo | Rol |
|---|---|
| `src/lib/impuestos.ts` | **`computeTaxPosition(companyId, year, month)` — fuente de verdad.** Calcula IVA (flujo) e ISR provisional régimen-aware. Devuelve `coeficienteFuente`, `retencionesAcreditadas`, `tarifaVerificada`. |
| `src/lib/fiscal/tarifas.ts` | Tarifas ISR versionadas (git-tracked), con `vigencia` y `verificado`. Anual PF 2024 + 2026 (2025 resuelve a 2024 por roll-forward). Helpers: `tarifaAnualPF`, `tarifaPeriodoPF`, `aplicarTarifa`. |
| `src/lib/fiscal/declaracion-anual.ts` | Declaración anual PF (aún tiene su propia tabla inline — TODO: importar de `tarifas.ts`). |
| `src/lib/fiel.ts` | `parseCertExpiry()` (X509 `validTo`), `fielStatus()` → ok/por_vencer(≤30d)/vencida/sin_fiel. |
| `src/lib/sat-sync.ts` + `src/lib/facturas/import-cfdi.ts` | Importación CFDI + **clasificación de dirección** (ver §3). |
| `src/app/api/papeles/isr/route.ts` | Papel de trabajo ISR. El branch 612 (PF act. empresarial) ahora jala de `computeTaxPosition`. |

### Cómo se calcula hoy
- **IVA**: 100% por flujo (Art. 1-B), base-REP, sobre CFDIs. PM y PF igual.
- **ISR provisional**:
  - PM → Art. 14: coeficiente de utilidad × ingresos acum × 30%.
  - PF act. empresarial (612) → Art. 106: tarifa elevada al periodo.
  - RESICO PF (626) → Art. 113-E: tasa sobre ingresos cobrados.
- **Coeficiente de utilidad**: autoritativo desde `DECLARACION_ANUAL` del año previo
  (`coeficienteFuente`), con fallback calculado.
- **Retenciones**: acreditadas vía `retencionesAcreditadas` (lo efectivamente retenido en
  los CFDIs, no una tasa asumida): 10% PM a PF act. empresarial (Art. 106) y 1.25% PM a
  RESICO PF (Art. 113-J). En RESICO la over-retención (común en brackets bajos) se arrastra
  como saldo a favor al periodo siguiente (`isr.saldoAFavor` → `isrSaldoFavor` en la
  declaración guardada → `isr.saldoFavorAnterior` del mes siguiente). Dentro del ejercicio.

---

## 2. Sincronización SAT (cron) — FUNCIONANDO

- GitHub Actions → endpoints Railway con `CRON_SECRET`.
- `/api/cron/sat-sync` corre periódicamente; `lastAutoSyncAt` se popula → confirmado vivo.
- `/api/cron/sat-rawxml-backfill` cada 6h (workflow `.github/workflows/sat-rawxml-backfill.yml`).
- **Gotcha resuelto**: el workflow necesita `set -euo pipefail` o `curl | tee` enmascara fallos
  como éxito. `STAGING_URL` y `CRON_SECRET` deben estar seteados en GitHub Secrets (ambos
  estaban vacíos antes; ya corregido).
- Tras cada sync, `notifyNewInvoices(company.id, runStart)` dispara el digest push.

---

## 3. Bug resuelto: gastos contados como ingresos

**Causa raíz**: se confiaba en `TipoDeComprobante` (I/E) en vez del rol emisor/receptor.
Una factura tipo "I" emitida _hacia_ la empresa (gasto) entraba como INGRESO.

**Fix de código** (ambos paths de import):
```
satType === NOMINA/PAGO/TRASLADO ? satType
  : isEmisor ? "INGRESO" : "EGRESO"
```
**Fix de datos**: `UPDATE ... WHERE notas LIKE '%recibidos' AND tipo='INGRESO'` → 299 filas
corregidas. ⚠️ La consola de Railway corre **una sola** sentencia a la vez — correr el UPDATE solo.

---

## 4. Notificaciones push (PWA + desktop) — FUNCIONANDO

- Web Push con VAPID. SW en `public/sw.js` (handlers `push` + `notificationclick`).
- `src/lib/push.ts`, `src/lib/notify-new-invoices.ts`, `src/components/pwa/PushOptIn.tsx`.
- Endpoints `/api/push/subscribe` y `/api/push/test`. Modelo `PushSubscription`.
- **Gotcha**: el opt-in debe registrar el SW explícitamente (no esperar `serviceWorker.ready`
  durante hidratación) + watchdog.

---

## 5. PENDIENTE — batch de correctitud fiscal (para sesión nueva)

En orden de prioridad. Todo correctitud-crítico → revisar contra Anexo 8 RMF / LISR.

1. **Otros regímenes ISR**:
   - ✅ 606 Arrendamiento: hecho — `src/lib/fiscal/isr-arrendamiento.ts`, mensual standalone
     sobre flujo (base-REP), deducción ciega 35% (Art. 115, sin predial), tarifa mensual
     Art. 96 (= anual/12), retención 10% PM (Art. 116). Pendiente anotado: opción
     comprobadas + predial, y pago trimestral (≤10 UMA).
   - 605 Sueldos y salarios (Art. 96 mensual + subsidio) — mejor junto con el track de nómina.
   - 625 Plataformas digitales (retención por plataforma).
   - 621 RIF (en extinción, reducción decreciente).
   - 622 AGAPES (exención + reducción).
✅ **IVA proporción de acreditamiento (Art. 5 LIVA)**: hecho — `calcularActosDelPeriodo`
   (`src/lib/fiscal/iva.ts`) calcula gravados/exentos desde el desglose real del CFDI
   (filas `InvoiceTax` con `factor` EXENTO y `base`) y el motor prorratea el acreditable.
   v1 trata todo gasto como "indistinto" (Art. 5-V c); refinamiento futuro: destino por
   gasto. Prerequisito resuelto: el parser ahora extrae el nodo `<cfdi:Impuestos>` completo
   (traslados + retenciones) y hay backfill (`/api/cron/invoice-taxes-backfill`) — esto
   también arregló que las retenciones acreditadas leyeran 0 en CFDIs sincronizados del SAT.
3. **PTU + pérdidas fiscales**: arrastre de pérdidas (10 años, actualizadas) y PTU pagada
   como disminución de la base.
4. **Cancel sync**: descarga de metadata para detectar CFDIs cancelados y revertir su efecto.
   Necesita prueba contra SAT en vivo (descarga masiva, RequestType metadata).
✅ **RESICO PF — retención 1.25% (Art. 113-J)**: hecho — `computeTaxPosition` acredita lo
   retenido en los CFDIs de ingreso del mes contra el ISR RESICO definitivo.

✅ **Saldo a favor RESICO**: hecho — la over-retención se arrastra al periodo siguiente vía
   `isrSaldoFavor` en la fila `ISR_PROVISIONAL` guardada (mismo patrón de cadena que el IVA:
   depende de declaraciones guardadas). No cruza ejercicios — el excedente de diciembre se
   recupera en la anual (Art. 113-F), no contra enero.

---

## 6. PENDIENTE — operativo (lado usuario)

- Rotar el password de la BD `uuOtmQtGzqOGddMaKfImDGpquMLdaAJf` (se expuso en chat).
- Borrar branches `claude/*` ya mergeados.
- Al arrancar nómina: extraer del PDF "Cuadros Permanentes 2026" la tarifa **mensual Art. 96**
  + tablas de **subsidio** + tablas **RESICO** y agregarlas a `tarifas.ts` con `verificado: true`.
  **Avance**: la plomería ya está — `tarifas.ts` tiene `tarifaMensualSueldos()` (2024 verificada,
  2026 resuelve roll-forward marcado NO vigente) y `subsidioEmpleo()` (mecanismo del decreto
  DOF 01-may-2024; 2025 con pct 13.8%/tope 10,171 **sin cotejar**). La nómina ya consume estas
  tablas versionadas por ejercicio de la fecha de pago y el run devuelve `tarifaWarning` cuando
  calcula con tablas sin verificar. **Falta solo**: del PDF, (1) tarifa mensual 2026, (2) subsidio
  2026 (pct + tope), (3) UMA 2026 (env `UMA_DIARIO`), (4) salario mínimo 2026 → flip verificado.

---

## 7. PENDIENTE — track de nómina (foco real del despacho)

El despacho objetivo hace **outsourcing de nómina** sobre varias empresas.

- **Correctitud**: Art. 96 mensual + subsidio al empleo, IMSS/INFONAVIT, finiquito, aguinaldo.
- **Rediseño** (patrón "dos profundidades": vista amigable en la ruta + workspace en `/<ruta>/detalle`):
  roster de empleados, run-payroll, enteramiento.
- **Cockpit multi-RFC**: ver/operar varias empresas desde un solo panel.

---

## 8. Convenciones del repo

- Next.js 15 App Router · Tailwind 3.4 (HSL vars shadcn) · Radix · lucide-react · Prisma/PostgreSQL · NextAuth.
- Tokens de marca namespaced `cos-*` (OKLCH) para no pisar los built-in de Tailwind.
- Patrón redesign: **vista amigable** en la ruta + **workspace power-user** en `/<ruta>/detalle`.
- Validación en sandbox: solo `tsc` (no `next build` — fetch de Geist bloqueado).
  Modelos nuevos: `npx prisma generate`. Lockfile: `npm install --package-lock-only`.
