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
   - ✅ 625 Plataformas digitales: hecho — `src/lib/fiscal/isr-plataformas.ts`, pago definitivo
     mensual con tasa fija Art. 113-A por actividad (transporte 2.1% / hospedaje 4% / servicios
     1%) sobre ingresos cobrados (flujo) − retenciones de plataformas (del CFDI). El tipo de
     actividad se configura en `/empresa` (campo `Company.plataformaActividad`); sin configurar
     asume servicios 1% y lo señala.
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
4. ✅ **Cancel sync**: implementado — `syncCancelacionesPeriodo` (sat-sync.ts) baja metadata
   (RequestType "metadata", `MetadataPackageReader`) y `interpretarCancelaciones`
   (`sat-cancelaciones.ts`, puro/unit-testeado) marca CANCELLED las facturas STAMPED que el
   SAT reporta canceladas (el motor ya las excluye). Cron `/api/cron/sat-cancel-sync`
   encadenado a `sat-sync.yml` (2×/día). ⚠️ Falta una corrida real contra el SAT para
   confirmar el formato del paquete de metadata antes de confiar 100% — el marcado es
   conservador (sólo STAMPED→CANCELLED de UUIDs que ya tenemos).
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
  **Avance**: `tarifas.ts` tiene `tarifaMensualSueldos()` — **2026 verificada** fila por fila
  contra Cuadros Permanentes 2026 (`docs/fiscal/cuadros-permanentes-2026.pdf`, Anexo 8 RMF 2026
  DOF 28-dic-2025), que además re-verificó la anual 2026, las elevadas Art. 106 (el escalado
  meses/12 coincide al centavo) y que la mensual Art. 116 (arrendamiento) es la MISMA tabla.
  La nómina consume las tablas versionadas por ejercicio de la fecha de pago y el run devuelve
  `tarifaWarning` cuando calcula con tablas sin verificar.
  ✅ **Resuelto** (decreto DOF 31-dic-2025 + INEGI, aportados en sesión): subsidio 2026
  verificado (15.02% UMA, tope $11,492.66; **enero 15.59% sobre UMA 2025** por transitorio —
  la UMA del año rige desde el 1-feb), 2025 confirmado (13.8%/$10,171); UMA 2026 $117.31
  (default en `constants.ts`, env `UMA_DIARIO` overridea); salario mínimo 2026 $315.04
  (`SALARIO_MINIMO_GENERAL`). El motor de nómina queda con todas las tablas 2026 verificadas.

---

## 7. PENDIENTE — track de nómina (foco real del despacho)

El despacho objetivo hace **outsourcing de nómina** sobre varias empresas.

- ✅ **Correctitud**: Art. 96 mensual + subsidio al empleo — hecho con tablas 2026 verificadas
  (ver §6). IMSS/INFONAVIT/finiquito/aguinaldo ya existían (`src/lib/nomina/*`).
- ✅ **Rediseño dos profundidades**: hecho — vista amigable en `/nomina` (equipo, masa salarial,
  última corrida, alerta de salarios bajo el mínimo, recordatorio de enteramiento) y el
  workspace completo movido a `/nomina/detalle` (roster, corridas, incidencias, modales).
  `createPayrollRun` devuelve `salarioMinimoWarning` + `tarifaWarning` y el modal de nueva
  corrida los muestra al contador.
- ✅ **Cockpit multi-RFC**: hecho — `/nomina/cockpit` (+ `/api/nomina/cockpit`): tabla de todas
  las empresas accesibles (membresía directa ∪ despacho con scoping) con empleados, masa
  salarial, neto del mes, última corrida, semáforo operativo (al corriente / sin timbrar /
  sin corrida / setup incompleto / bajo mínimo) y botón "Operar" que cambia la empresa activa
  y abre su workspace. Agregados con groupBy/distinct — sin N+1.

---

## 9. EN PROGRESO — motor de deducibilidad (naturaleza del CFDI)

Complementa `docs/HANDOFF-deduction-engine.md` (branch `claude/handoff-deduction-engine`) y
las reglas del asistente en `system-prompt.ts` ("Naturaleza fiscal de un CFDI"). Hoy un activo
fijo (computadora, vehículo) entra 100% como gasto del periodo en vez de depreciarse →
sobre-deducción.

- ✅ **Fase 1 — clasificación (hecho)**: `src/lib/fiscal/clasificar-cfdi.ts` (puro, unit-testeado)
  deriva la **naturaleza** del `usoCfdi`: G01→INVENTARIO (Art. 39), I01–I08→INVERSION (Art.
  31/34, con subtipo y bandera de tope Art. 36-II para autos de pasajeros vs carga), S01→
  SIN_EFECTOS, G03/faltante→GASTO (y **marca revisión** si la clave de producto parece activo
  fijo — el default G03 no se confía a ciegas). Campos nuevos en `Invoice`: `naturaleza`,
  `naturalezaRevision`, `naturalezaManual`. Se asigna en los 3 paths de import (sat-sync,
  import-cfdi, upload-cfdi); backfill en `/api/cron/naturaleza-backfill`; override del contador
  vía `PATCH /api/facturas/[id]` ({naturaleza}) y selector en el modal de la factura.
  **NO toca el cálculo de ISR todavía** (a propósito).
- ✅ **Fase 2a — registro de inversiones + motor de depreciación (hecho)**:
  `src/lib/fiscal/depreciacion.ts` (puro, unit-testeado): tasas Art. 34 por tipo, tope
  Art. 36-II (auto $175k / eléctrico $250k; pickup de carga sin tope), prorrateo por meses de
  uso, tope al saldo por deducir, factor INPC (Art. 31). **INPC cargado** en
  `src/lib/fiscal/inpc.ts` (ene–ago 2016–2026 + ene–may 2026, incluye junio = numerador anual):
  `factorActualizacionDepreciacion` calcula INPC(últ. mes 1ª mitad) ÷ INPC(mes adq.) y el
  registro muestra el factor; cae a nominal donde falta el índice. ⚠️ INPC `verificado: false`
  (faltan sep–dic y cotejar contra INEGI).
  Modelo `ActivoFijo` + API `/api/activos` (alta desde CFDI INVERSION o manual, lista con la
  depreciación calculada del ejercicio) y `/api/activos/[id]` (editar/baja/eliminar). Página
  `/activos` (registro + tabla de depreciación) y botón "Registrar como activo fijo" en el modal
  de la factura. **NO toca el ISR todavía.**
- ✅ **Fase 2b-anual — wiring atómico en la declaración anual (hecho)**: `declaracion-anual`
  route ahora agrupa los EGRESO por `naturaleza` y **excluye INVERSION y SIN_EFECTOS de las
  compras**, y alimenta la **depreciación calculada del registro** (helper compartido
  `src/lib/fiscal/activos-registro.ts` → `calcularDepreciacionRegistro`, usado también por
  `/api/activos`) como default de la deducción de inversiones (el contador la sobreescribe con
  `?depreciacion=`). El UI muestra la fuente de la depreciación y las notas de inversión/sin-
  efectos excluidas. INVENTARIO sigue en compras (su costo de lo vendido es Fase 3). El cálculo
  anual es el definitivo, así que esto corrige el ISR del ejercicio aunque las provisionales
  mensuales aún no lo reflejen.
- ⏳ **Fase 2b-mensual (siguiente)**: PF act. empresarial (`impuestos.ts` `flujoEfectivoAcum`)
  deduce hoy todo EGRESO pagado → excluir INVERSION/SIN_EFECTOS y sumar la depreciación
  proporcional ene→mes (requiere variante del motor que tope los meses al mes en curso). Sólo
  afecta provisionales 612 (PM usa coeficiente; RESICO/plataformas/arrendamiento no deducen
  compras). **Datos**: INPC cargado ene–ago 2016–2026 (faltan sep–dic + cotejar). Ojo: IVA
  acreditable del activo es inmediato (flujo), sólo el ISR se difiere.
- ⏳ **Fase 3 — costo de lo vendido (sólo PM que venden)**: método periódico (inv. inicial +
  compras − inv. final). No requiere tracker perpetuo por SKU. Diferido.

## 8. Convenciones del repo

- Next.js 15 App Router · Tailwind 3.4 (HSL vars shadcn) · Radix · lucide-react · Prisma/PostgreSQL · NextAuth.
- Tokens de marca namespaced `cos-*` (OKLCH) para no pisar los built-in de Tailwind.
- Patrón redesign: **vista amigable** en la ruta + **workspace power-user** en `/<ruta>/detalle`.
- Validación en sandbox: solo `tsc` (no `next build` — fetch de Geist bloqueado).
  Modelos nuevos: `npx prisma generate`. Lockfile: `npm install --package-lock-only`.
