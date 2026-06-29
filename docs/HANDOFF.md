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
  registro muestra el factor; cae a nominal donde falta el índice. ✅ INPC **cotejado** contra
  **Banxico SIE (serie SP1)** por cron semanal (ver §10); el flag estático `INPC_VERIFICADO`
  queda en `false`, pero el cotejo promueve el dataset a "al día" en tiempo de ejecución. Aún
  faltan sep–dic en el seed.
  Modelo `ActivoFijo` + API `/api/activos` (alta desde CFDI INVERSION o manual, lista con la
  depreciación calculada del ejercicio) y `/api/activos/[id]` (editar/baja/eliminar). Página
  `/activos` (registro + tabla de depreciación) y botón "Registrar como activo fijo" en el modal
  de la factura. **NO toca el ISR todavía.**
  ✅ **Auto-registro (hecho)**: los CFDIs INVERSION se capitalizan SOLOS al sincronizar
  (`src/lib/fiscal/auto-activo.ts`, idempotente por invoiceId) — depreciación sin captura
  manual; el contador sólo revisa (badge "auto — revisa tipo/tasa/tope" en `/activos`, se limpia
  al editar). Backfill `/api/cron/activos-backfill` para INVERSION ya importados. El edge "solo
  corre" se mantiene end-to-end: sync → clasifica → capitaliza → deprecia → ISR.
- ✅ **Fase 2b-anual — wiring atómico en la declaración anual (hecho)**: `declaracion-anual`
  route ahora agrupa los EGRESO por `naturaleza` y **excluye INVERSION y SIN_EFECTOS de las
  compras**, y alimenta la **depreciación calculada del registro** (helper compartido
  `src/lib/fiscal/activos-registro.ts` → `calcularDepreciacionRegistro`, usado también por
  `/api/activos`) como default de la deducción de inversiones (el contador la sobreescribe con
  `?depreciacion=`). El UI muestra la fuente de la depreciación y las notas de inversión/sin-
  efectos excluidas. INVENTARIO sigue en compras (su costo de lo vendido es Fase 3). El cálculo
  anual es el definitivo, así que esto corrige el ISR del ejercicio aunque las provisionales
  mensuales aún no lo reflejen.
- ✅ **Fase 2b-mensual (hecho)**: provisional PF act. empresarial (612) — `flujoEfectivoAcum`
  excluye INVERSION/SIN_EFECTOS de `deduccionesPagadas` (filtro PUE + PPD por naturaleza del
  padre; null/legacy se conserva como gasto) y la rama 612 suma la depreciación proporcional
  ene→mes (`calcularDepreciacionRegistroPeriodo`, vía nuevo `hastaMes` del motor). Sin doble
  conteo. Sólo afecta 612 (PM usa coeficiente; RESICO/plataformas/arrendamiento no deducen
  compras). **El arco de deducibilidad queda cerrado** salvo Fase 3 y completar el INPC (sep–dic).
  INPC cargado ene–ago 2016–2026; ya **cotejado automáticamente contra Banxico** (§10). IVA acreditable del activo
  es inmediato (flujo); sólo el ISR se difiere.
- ⏳ **Fase 3 — costo de lo vendido (sólo PM que venden)**: método periódico (inv. inicial +
  compras − inv. final). No requiere tracker perpetuo por SKU. Diferido.

## 10. Cobertura de datos fiscales (chequeo time-aware de frescura)

`src/lib/fiscal/cobertura-datos.ts` → `evaluarCoberturaFiscal(asOf)`: dado el reloj del
SERVIDOR y el calendario de publicación de cada dataset versionado (INPC ~día 9 del mes
siguiente; tarifas/subsidio dic del año previo; UMA 1-feb; SM 1-ene), clasifica cada uno en
`al_dia | por_publicar | faltante | sin_cotejar`. Distingue "aún no se publica" de "ya se
publicó y no lo tenemos" — p.ej. en julio detecta que falta el INPC de junio, pero el 5-jul aún
no. El **cálculo nunca depende del reloj** (cae a nominal/verificado:false); esto es sólo la
capa de monitoreo. API `GET /api/fiscal/cobertura` (`?asOf=` para simular) y tarjeta en
`/cumplimiento`. Cada dataset expone su `cobertura*()` (último cargado + verificado).

**Cotejo automático (INPC).** `src/lib/fiscal/cotejo.ts` + `cobertura-con-cotejo.ts`: el INPC
cargado se coteja contra **Banxico SIE, serie SP1** (`src/lib/fiscal/banxico.ts`) — INEGI **no**
expone el INPC en su API de Banco de Indicadores (sólo UMA), por eso usamos Banxico. Si todos los
meses empatan (tol. 0.001) escribe `CotejoFiscal{ verificado, verifiedThrough }` y la capa
`coberturaConCotejo` promueve el dataset de `sin_cotejar` → `al_dia`. Cron semanal
`/api/cron/cotejo-fiscal` (workflow `cotejo-fiscal.yml`, lunes). **Requiere `BANXICO_TOKEN`** en
el entorno de la app (Railway); sin él el cron se omite solo. El mismo token alimenta el **FIX
informativo** (serie `SF43718`, `fetchTipoCambioFix`, falla suave + cache 6 h) que la API de
cobertura devuelve como `tipoCambioFix` junto a `inpcUltimo`, y la tarjeta de `/cumplimiento`
muestra como dato de referencia. **Sin lógica de fluctuación cambiaria todavía** (Art. 8 LISR —
ganancia/pérdida como interés): cuando se necesite habría que agregar tabla histórica del FIX +
cron diario + revaluación de saldos en USD.

## 11. Cockpit del despacho (multi-RFC, todas las obligaciones)

`/despacho` (+ `GET /api/despacho/cockpit`): una fila por empresa accesible (helper
`empresasAccesiblesIds` en authz, reutilizado por el cockpit de nómina) con el estado de la
declaración del periodo (presentada/calculada/pendiente/vencida, derivado de `TaxDeclaration`
guardadas — **sin recomputar el motor**, para escalar a muchos RFC), monto a pagar de lo ya
calculado, nómina sin timbrar y empleados; "Operar" cambia la empresa activa y entra a su cierre/
nómina. Franja superior con las alertas de cobertura de datos (§10). Complementa el cockpit de
nómina (`/nomina/cockpit`, sólo nómina). Sidebar: "Despacho".

## 12. Auditoría de diseño (Contia) — seguimiento

Audit externo (~70% del proposal en main). Estado:
- ✅ Cockpit del despacho (era el "flagship gap" del audit) — hecho (§11, `/despacho`).
- ✅ Panel de IA re-skineado a spec (header blanco + tile sparkle, burbujas brand/paper, copy de
  prompts "¿Por qué debo este IVA?/¿Qué pasa si no presento la DIOT?") + fix de tokens del grupo
  inferior del sidebar (ya no usa `bg-primary` legacy).
- ✅ **Clientes** y **Contabilidad** migrados a tokens `cos-*` (tabla/tabs/modales/colores
  semánticos jade-red). En Contabilidad se conservó `formatCurrency` en las tablas densas
  (balanza/estado) para no romper alineación; el resto en sistema.
- ✅ **Un solo azul (hecho)**: en vez de borrar `--primary` (lo usan los primitivos cos
  Button/Card y ~24 pantallas — borrarlo rompería), se **remapeó** `--primary`/`--ring` (light+dark)
  al azul de marca `hsl(215 64% 49%)` = `--brand`. Así cualquier `bg-primary`/`ring-primary`
  residual (configuración, onboarding, auth, Button default) rinde el azul de marca — el riesgo
  de "dos azules" queda eliminado estructuralmente, sin tocar 28 archivos ni arriesgar regresiones.
- ⏳ **Opcional**: barrido mecánico para mover las pantallas restantes (cluster configuración,
  onboarding, login/signup) y los grises shadcn (`--border`/`--muted-foreground`/`--accent`) a
  tokens `cos-*`, y entonces sí borrar la paleta legacy. Bajo valor visual ya (los grises no
  chocan; el azul ya está unificado); alto trabajo. Diferible.

## 13. Piloto outsourcing — fundación de Grupos (multi-empresa, intercompañía)

Contexto: cliente con 2 grupos × 3 empresas que se facturan entre sí; escalará a ~60.
Decisión: NO se forkea el front — un solo código + módulos gateados (patrón `CONSTRUCCION`),
shell de operador vía route-group si se quiere, y el alta de empresas es repetible/incremental
(reusa `POST /api/companies`, que ya siembra catálogo/obligaciones/Facturapi/FIEL/sync). No
hacer un wizard monolítico de 60.

- ✅ **Grupo (hecho)**: modelo `Grupo` (bajo `Despacho`) + `Company.grupoId`. API `/api/grupos`
  (GET con conteos/empresas, POST crear). `grupoId` se acepta en crear y editar empresa (valida
  mismo despacho). Selector + "Nuevo grupo" en el form de alta (`/empresa`). Helper
  `src/lib/grupo.ts`: `rfcsHermanos(companyId)` + `esContraparteIntercompania(...)` para detectar
  CFDIs entre partes relacionadas (Art. 69-B CFF). **Coexistente, nada se sustituyó.**
- ⏳ **Siguiente (piloto)**: (a) **alta repetible/batch** con prefill por CSF (IA) + grupo; (b)
  **etiquetar CFDIs intercompañía** en facturas/papeles usando el helper; (c) **comisiones**
  (ledger separado del motor fiscal: ganado vs gastado por grupo); (d) **materialidad** (evidencia
  por CFDI: checklist contrato/entrega/pago/correspondencia; el pago se auto-cubre con la
  conciliación bancaria; reforzada para intercompañía). Pendiente confirmar: quién cobra a quién
  (comisiones) y backend de archivos (materialidad).

## 14. Captura de declaraciones (acuses PDF) + nag de cobertura

Objetivo: que el sistema **pida** los acuses de declaración faltantes y, al subirlos,
guarde el **PDF completo** + los campos parseados para arrastrar saldos a favor,
coeficiente de utilidad y pagos provisionales — sin teclear línea de captura ni montos.

- ✅ **Detector** `src/lib/fiscal/cobertura-declaraciones.ts`: regla = año cerrado → anual
  (cubre ISR mensual del año); IVA dic del año previo (no hay anual de IVA → arrastre de saldo);
  año en curso → mensuales transcurridos. No re-pide lo ya capturado (incluye lo histórico).
- ✅ **API**: `/api/declaraciones/cobertura` (GET, operador-aware) y `/api/declaraciones/save`
  (POST: parsea con el extractor existente y guarda `TaxDeclaration` + `acusePdf` bytea).
- ✅ **Pantalla** `/declaraciones` (checklist por empresa→periodo, subir PDF) + banner en el
  cockpit + item en el sidebar. Reusa `/api/onboarding/parse-document` (ya clasifica ACUSE_*).
- 🚩 **Almacenamiento PDF**: por ahora en Postgres (`TaxDeclaration.acusePdf Bytes?`).
  **TODO (recordatorio del dueño): migrar a Cloudflare R2** (object storage) y dejar sólo la URL;
  también sirve para materialidad (§13). Los acuses son chicos (<300 KB) así que la BD aguanta el
  piloto, pero no es la solución final.
- ⏳ **Pendiente**: (a) push agregado por despacho (entre semana, mientras falten); (b) quitar la
  captura manual de línea/monto en `impuestos/detalle` y `cierre` (reemplazar por "subir acuse");
  (c) colapsar el "calcula cuánto facturar" (pre-cierre) en un panel opcional.

## 8. Convenciones del repo

- Next.js 15 App Router · Tailwind 3.4 (HSL vars shadcn) · Radix · lucide-react · Prisma/PostgreSQL · NextAuth.
- Tokens de marca namespaced `cos-*` (OKLCH) para no pisar los built-in de Tailwind.
- Patrón redesign: **vista amigable** en la ruta + **workspace power-user** en `/<ruta>/detalle`.
- Validación en sandbox: solo `tsc` (no `next build` — fetch de Geist bloqueado).
  Modelos nuevos: `npx prisma generate`. Lockfile: `npm install --package-lock-only`.

## 9. Deploys (Railway) y cambios de esquema

- El deploy sincroniza el esquema con `prisma db push` (no migraciones) en `railway.json`
  → `preDeployCommand`. Lleva `--accept-data-loss` para que NO se bloquee ante cambios que
  Prisma marca como "potencialmente destructivos" (p.ej. **agregar un `@unique`**, que casi
  siempre es seguro). Sin el flag, esos cambios detienen el contenedor (`Error: Use the
  --accept-data-loss flag`).
- **Implicación:** como el push aplica el esquema tal cual, un cambio realmente destructivo
  (renombrar/eliminar columna → Prisma lo ve como drop+add y pierde datos) se aplicaría en el
  deploy. **Revisa el diff de `prisma/schema.prisma` en cada PR**; ese es el verdadero guardarraíl.
- No corras el push "a mano" desde el shell de Railway para arreglar un deploy roto: ese shell
  vive en el contenedor en ejecución (deploy viejo) y compara contra un `schema.prisma` anterior,
  así que reporta "already in sync" sin aplicar nada. El fix correcto es que el propio deploy
  aplique el cambio (con el flag).
- A futuro, si se quiere control fino sin riesgo de pérdida silenciosa, migrar a `prisma migrate`
  (archivos de migración revisados) en lugar de `db push`.

## 15. WhatsApp — vinculación y plantilla OTP

- **Vinculación (Ajustes → WhatsApp):** el usuario captura su número; enviamos un código de 6
  dígitos por WhatsApp y lo confirma en la app. Sólo cuando el código es correcto se fija
  `WhatsappLink.verifiedAt` — es lo ÚNICO que el canal de WhatsApp confía (el caller ID por sí
  solo nunca autoriza). Tras enviar el código, la UI muestra el número canónico que registramos
  (`+52 ## #### ####`) para que el usuario confirme que es el suyo antes de verificar.
- **Normalización de número (`src/lib/whatsapp/identity.ts → normalizePhone`):** canonicaliza a
  `+52##########`. Acepta `+521…`/`521…` (el "1" de móvil que entrega WhatsApp/Twilio),
  `52…`, `+52…` y 10 dígitos pelones (se asume México). `resolveSender` busca con `phoneVariants`
  (`+52…` y `+521…`) para tolerar enlaces guardados con cualquiera de las dos formas.
- **Plantilla OTP (error 63016) — ACCIÓN PENDIENTE en Twilio/Railway:** WhatsApp/Meta bloquea los
  mensajes freeform iniciados por el negocio (como el código OTP) fuera de la ventana de servicio
  de 24h; Twilio lo reporta con **código 63016**. En ese caso `startLink` devuelve
  `reason: "template_required"` y la UI pide al usuario escribir primero por WhatsApp (abre la
  ventana de 24h) o contactar soporte.
  - **Fix permanente:** registrar una plantilla de **autenticación (OTP)** en el Content Template
    Builder de Twilio (categoría *Authentication*; el código va en la variable `{{1}}`), esperar la
    aprobación de Meta, y fijar `TWILIO_OTP_TEMPLATE_SID` (el `HX…`) en las variables de entorno de
    Railway. Con esa variable presente, `startLink` envía el OTP vía `sendWhatsappTemplate` (entregable
    a números "fríos") en lugar del freeform.
