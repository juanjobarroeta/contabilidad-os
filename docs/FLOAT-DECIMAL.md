# Float → Decimal en dinero — plan por olas

**Estado:** ✅ COMPLETO — las 6 olas (0–5) en producción. Todo el dinero del
schema vive en `numeric(18,6)`; los únicos `Float` restantes son no-dinero a
propósito (porcentajes, rendimiento, stock, scores — 20 columnas).
**Por qué:** hay 232 campos `Float` en el schema; ~190 son dinero. `float8`
no representa decimales exactos (0.1 + 0.2 ≠ 0.3): los importes derivan
centavos al acumularse y los `SUM()` de Postgres arrastran ruido binario. Un
producto contable guarda dinero en `NUMERIC`. Es además un señalamiento
directo de la revisión de due-diligence (Fase 1 del GTM).

## Diseño

**La base guarda exacto; la app sigue operando con `number`.**

1. **Columnas:** `Float` → `Decimal @db.Decimal(18, 6)` en campos de dinero
   (el CFDI permite hasta 6 decimales; 18,6 cubre importes hasta ~1e12 MXN).
   Tasas y tipo de cambio van con su ola, mismo tipo. Porcentajes de avance,
   scores de confianza y stock **se quedan `Float`** — no son dinero.
2. **Runtime:** el cliente compartido (`src/lib/prisma.ts`) convierte
   `Prisma.Decimal → number` en TODO resultado — modelos, `aggregate`,
   `groupBy` y `$queryRaw` — vía `$allOperations` + `decimalesANumero()`
   (`src/lib/prisma-decimal.ts`). El contrato de la app no cambia: mismos
   `number` de siempre (ahora leídos de un valor exacto a 6 decimales), misma
   forma de JSON en las APIs. Los scripts importan el mismo cliente, así que
   también quedan cubiertos.
3. **Tipos:** los tipos generados de Prisma sí dicen `Decimal` en los campos
   convertidos. Tras cada ola, `tsc` marca en rojo cada lectura que hace
   aritmética — esa lista ES el worklist de la ola. El arreglo mecánico es
   envolver la lectura en `Number(...)`: correcto en tipos y, en runtime,
   identidad (el convertidor ya entregó `number`).
4. **Escrituras:** Prisma acepta `number` en columnas `Decimal` — el código
   de escritura existente no cambia. Postgres redondea a 6 decimales al
   guardar: el almacenamiento sanea el ruido flotante de origen.
5. **Guardia de magnitud:** convertir a `number` es exacto en la práctica
   para dinero; si un valor excede 2^53−1, `decimalesANumero` lo reporta por
   `console.error` en vez de truncar en silencio.
6. **Futuro (opt-in):** cuando un camino fiscal quiera aritmética exacta de
   punta a punta (p. ej. timbrado), podrá usar un handle sin conversión y
   operar `Prisma.Decimal` directamente. No es parte de estas olas.

## Inventario (2026-08-26)

232 `Float` en `prisma/schema.prisma`: ~190 dinero (importes, saldos,
sueldos, impuestos, debe/haber), 5 tasas/tipo de cambio, ~24 cantidades,
~13 no-dinero que se quedan `Float` (`pct*`, `porcAvance`, `rendimiento`,
`confianza`, `confidence`, `score`, `stock`). El clasificador vive en el
historial de este doc; regenerar es un grep de `Float` + juicio por nombre.

## Las olas

Cada ola: rama → schema → SQL a mano → `tsc` rojo → `Number()` → tests →
cuadre → staging → prod. **Orden por riesgo creciente y valor de canario:**

| Ola | Modelos | Nota |
|---|---|---|
| **0** ✅ | — (sin cambio de schema) | Convertidor + cuadre + este doc. Horneando en prod: el convertidor ya corre (no-op salvo `limiteCredito`, que ahora sale como `number` en JSON — antes string). |
| **1** | `BankTransaction` (monto, saldo), `BankAccount`, `ConciliacionBancaria`/`ConciliacionDetalle` (importes) | Canario: pocas columnas, uso intensísimo (mesa, auto-conciliación, cuadre diario). |
| **2** | `Invoice` (subtotal, descuento, totalImpuestos, total, tipoCambio, isrRetenidoNomina), `InvoiceItem`, `InvoiceTax` (base, importe, tasa), `PagoDoctoRelacionado`, `FacturaBorrador`, `CfdiFaltante` | Tablas más grandes → el `ALTER` reescribe la tabla; ventana tranquila. |
| **3** | `PayrollRun`, `PayrollItem` (todos los conceptos), `Employee` (sueldos/SBC), `Incidencia`, costos de nómina | El cálculo ya redondea a centavos; validar contra recibos timbrados. |
| **4** | `AccountingEntry` (monto), `CeBalanzaMes` (saldoIni/debe/haber/saldoFin), `TaxDeclaration` (todos los importes), `PerdidaFiscal`, `ActivoFijo` (moi, montos), `CompanyObligation`/`CostEvent` si aplican | El mayor y las declaraciones: aquí el SUM exacto es el premio. |
| **5** | Verticales: construcción (`APU*`, `Presupuesto*`, `Estimacion*`), purificadora, automotriz (`Vehiculo*`, `ServicioVenta`, `PedidoVehiculo`), restaurante, padel, créditos | Congelados de features, pero su dinero también cuadra. |

## Runbook por ola

1. Rama desde `main`; editar `prisma/schema.prisma` (sólo los campos de la
   ola).
2. Migración SQL **a mano** en `prisma/migrations/<fecha>_decimal_ola_N/`:
   un `ALTER TABLE` por tabla con todas sus columnas, casteando **vía texto**:
   `ALTER TABLE "X" ALTER COLUMN "c" TYPE numeric(18,6) USING round(("c"::text)::numeric, 6);`
   Lección del ensayo de la Ola 1: el cast directo `float8::numeric` trunca a
   15 dígitos significativos (1234567890.123456 → 1234567890.12346), mientras
   que `float8::text` imprime la representación más corta que round-tripea —
   exactamente lo que la app siempre vio. NaN/Infinity revientan el parse de
   numeric: dinero no-finito debe frenar la migración, no colarse.
3. `prisma generate` → `tsc` → envolver lecturas rojas en `Number()`.
4. Suite completa + integración (`npm run test:db`).
5. **Staging:** `decimal-cuadre.ts --out antes.json` → deploy (el
   `preDeployCommand` aplica la migración) → `--compare antes.json`. Debe
   cuadrar a ±0.01.
6. **Prod:** foto `--out` antes de mergear; mergear en ventana tranquila (el
   deploy de Railway aplica la migración; si falla, aborta y sigue sirviendo
   la imagen anterior); `--compare` al terminar; Sentry limpio 24 h antes de
   la siguiente ola.

## Riesgos y mitigaciones

- **Reescritura de tabla en el ALTER** (bloquea escrituras): las tablas
  grandes (Invoice, BankTransaction, InvoiceItem) van en ventana tranquila;
  medir filas antes (`SELECT count(*)`) y ensayar el tiempo en staging.
- **Ruido float8 preexistente:** el cuadre tolera ±0.01 por grupo; una
  divergencia mayor detiene la ola.
- **Raw SQL de la ola** (26 archivos con `$queryRaw`): el convertidor cubre
  el resultado, pero revisar los que hagan aritmética *dentro* del SQL con
  las columnas convertidas (numeric propaga exacto — normalmente es mejora
  gratis).
- **`limiteCredito` (ya Decimal):** desde la Ola 0 sale como `number` en las
  APIs (antes: string serializado). Único consumidor conocido: el route de
  terms de construcción, que escribe con `z.coerce.number()` — compatible.
- **Scripts con `new PrismaClient()` crudo** (~27 en `scripts/`, sobre todo
  seeds/backfills ya ejecutados y los `validate-*-postings.mjs`): NO pasan
  por el convertidor — a runtime reciben `Prisma.Decimal`, y `d1 + d2` en JS
  concatena strings en silencio. Los `.ts` que hacían aritmética los cachó
  `tsc` (arreglados); los `.mjs` no tienen red de tipos. **Antes de volver a
  correr uno de esos scripts, migrarlo al cliente compartido
  (`import { prisma } from "../src/lib/prisma"`) o envolver sus lecturas de
  dinero en `Number()`.**
