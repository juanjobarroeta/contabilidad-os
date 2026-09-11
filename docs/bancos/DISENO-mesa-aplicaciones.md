# La mesa enseña todo y aplica lo que sea: N movimientos ↔ N facturas

Fecha: 2026-09-11. **Estado: diseño en revisión, sin código.**

Lo que pidió el dueño: en la mesa, por movimiento, ver **el importe original con
todo lo que sabemos (CEP incluido), lo que falta por conciliar y el historial de
dónde se aplicó**; por factura, **el total, lo disponible, las aplicaciones con
enlace al historial y la información de PPD**; una interfaz que no meta todo
eso en cuadritos; y **una sola herramienta** para aplicar un depósito a una
factura, parte de un depósito, varios depósitos a una factura o al revés.

Restricción heredada (10-sep): *la mesa decide, el archivo busca*. El tab
Movimientos no se retira; enseña y entrega a la mesa. Este diseño la respeta.

---

## 1. Lo que ya existe y casi no se ve

| Lado | Dato | Dónde vive hoy | ¿Se ve en la mesa? |
|---|---|---|---|
| Movimiento | fecha, descripción cruda, importe, referencia | `Movimiento` (Workbench) | sí, en el renglón |
| Movimiento | contraparte nombre/RFC/CLABE, clave de rastreo, concepto | `spei-descripcion` → `Movimiento` | parcial (nombre) |
| Movimiento | **CEP de Banxico**: estado, fecha de operación, importe según Banxico, ordenante y beneficiario (nombre/RFC/banco/cuenta), concepto | `CepMovimiento` + `VisorCep` | sí, plegado, en el resolver |
| Movimiento | **contra qué quedó**: facturas con la porción de ESTE movimiento, o el impuesto | `CruceMovimiento` (`FacturaCruzada.montoAsignado`) | sí, sólo en el resolver y sólo si ya está conciliado |
| Movimiento | estado | `status` UNMATCHED / MATCHED / IGNORED | sí, como chip binario |
| Factura | total, ya aplicado, disponible | `matchedAmount`, `remainingBalance` (API de candidatos) | **no** — la tarjeta pinta el total |
| Factura | PUE / PPD | `metodoPago` | sí, chip |
| Factura | **REP**: parcialidades, saldo insoluto, pagado, último pago | `GET /api/facturas/[id]/complementos` (`saldo`, `parcialidades`, `numParcialidad`) | en Facturas, no en la mesa |
| Relación | cada aplicación (movimiento × factura × monto) | `ConciliacionDetalle` + el 1:1 viejo (`BankTransaction.invoiceId`) | como lista plana en el cruce |
| Relación | quién y cuándo | `AuditLog` | no |

**Lo que de verdad falta como dato son tres cosas, y son chicas:**

1. **`restante` del movimiento** (`|monto| − Σ montoAsignado`) y un estado de
   tres valores, no dos: `SIN_APLICAR · PARCIAL · COMPLETO` (+ `CATEGORIZADO`
   para lo que se ignoró con etiqueta). Hoy un depósito de $25,000 con $10,000
   aplicados es «Conciliado» igual que uno cerrado — el resto se fue a anticipo
   y nadie lo dice en el renglón.
2. **La aplicación como entidad de lectura**, igual desde los dos lados:
   `{ fecha, movimiento, factura, monto, rep?, quién, cuándo }`. Hoy el
   movimiento la ve como `FacturaCruzada`, la factura la ve como
   `matchedAmount` sumado, y el estado de cuenta la vuelve a sumar por su
   cuenta. Tres lecturas del mismo renglón de `ConciliacionDetalle`.
3. **El REP que ampara cada aplicación** (o su ausencia). El cruce existe en
   `rep-faltante.ts` (cobrado en banco − amparado por REP) pero agregado por
   factura; por aplicación se resuelve empatando `PagoDoctoRelacionado` por
   factura + `fechaPago` ≈ fecha del movimiento + `impPagado` ≈ porción.

---

## 2. Un solo modelo de lectura: `aplicaciones`

`src/lib/bancos/aplicaciones.ts` — puro en la decisión, con un repo aparte:

```ts
interface Aplicacion {
  id: string;                    // ConciliacionDetalle.id, o "1:1:<txId>" para el vínculo viejo
  movimiento: { id; fecha; descripcion; monto; cuenta; contraparteNombre; claveRastreo };
  factura:    { id; uuid; serie; folio; fecha; total; tipo; metodoPago; contraparte };
  monto: number;                 // la porción
  rep: { uuid; numParcialidad; impSaldoInsoluto; fechaPago } | "SIN_REP" | "NO_APLICA"; // PUE = NO_APLICA
  registro: { userId; email; fecha } | null;   // de AuditLog
}
aplicacionesDeMovimiento(txId)  → { original, cep, asignado, restante, estado, aplicaciones[] , anticipo? }
aplicacionesDeFactura(invoiceId) → { total, aplicado, disponible, estado, metodoPago, aplicaciones[], rep: { parcialidades, saldoInsoluto, siguienteParcialidad, plazoRep } }
```

Lo consumen los cuatro sitios que hoy suman por su cuenta: la mesa, el archivo
(Movimientos), el cajón de Facturas y el estado de cuenta de clientes. Una
sola suma, un solo estado.

---

## 3. «¿Qué más?» — lo que no se pidió y pertenece aquí

- **Anticipos.** El sobrante de un depósito no desaparece: se etiqueta
  `ANTICIPO_CLIENTE/PROVEEDOR` y vive en `bancos/anticipos`. La ficha del
  movimiento debe decir «$X aplicados a HH1440 · **$Y en anticipo**» y, cuando
  ese anticipo se aplique después a un CFDI, aparecer ahí como aplicación con
  origen «anticipo del 01/08».
- **Depósitos netos (terminal / comisión).** La factura es bruta, el depósito
  llega neto. La diferencia es **comisión**, no «restante»: la ficha la tiene
  que separar (`bancos/terminal.ts` ya sabe cuánto es) o la mesa marcará
  parciales que no lo son.
- **Notas de crédito (tipo E) y devoluciones.** Aplicaciones con signo: una
  devolución resta de lo cobrado de la factura padre. Hoy el neto se calcula
  (`matchedAmount` resta cargos) pero no se muestra como renglón.
- **Moneda.** Factura en USD cobrada en MXN: la aplicación lleva el tipo de
  cambio del día del cobro, y el disponible de la factura se expresa en su
  moneda.
- **IVA al flujo.** Cada aplicación mueve IVA al periodo de `fechaPago` (Art.
  1-B). La ficha debe decir en qué mes cae —es la razón de que la fecha del
  banco, y no la del REP, sea la que manda.
- **Plazo del REP.** Día 5 del mes siguiente al cobro (RMF 2.7.1.32).
  `ComplementosPendientes` ya lo calcula por cobro; la aplicación lo enseña.
- **Deshacer.** Cada aplicación con su «Desconciliar» (existe en Histórico)
  y su rastro en `AuditLog` (existe): quién la hizo, cuándo, y si se deshizo.

---

## 4. La interfaz: de cuadritos a fichas

Se conserva la mesa dividida (lista a la izquierda, resolver a la derecha).
Cambia lo que va dentro.

**El renglón del movimiento** (lista): dos líneas + columna de dinero.
Línea 1: contraparte (o descripción) · importe original en mono.
Línea 2: fecha · cuenta · clave de rastreo si hay · chip de estado de tres
valores. Bajo el importe, **una barra fina de aplicado/original** — en un
parcial se ve de lejos. Nada más en el renglón: lo demás vive en la ficha.

**El resolver** (derecha) pasa de una columna de tarjetitas a **tres fichas
apiladas, siempre en el mismo orden:**

1. **Movimiento.** Importe original grande; abajo, en dos columnas, lo que
   sabemos: contraparte con RFC, CLABE, clave de rastreo, concepto — y el CEP
   *resumido en línea* (estado · fecha Banxico · importe Banxico · ordenante →
   beneficiario) con «ver comprobante» para el detalle completo. Cierra con
   **Aplicado / Restante** en mono, y si hay anticipo, cuánto.
2. **Aplicaciones.** Tabla: fecha · factura (serie+folio · contraparte) ·
   monto · REP (parcialidad N / sin REP / no aplica) · quién · deshacer. Un
   movimiento nuevo la trae vacía y dice «sin aplicar»; uno con anticipo lo
   lista como renglón.
3. **Aplicar.** La herramienta (§5). Los candidatos, el pago junto, los
   impuestos pendientes y la búsqueda manual viven aquí, como hoy — pero
   alimentan la herramienta, no compiten con ella.

**El cajón de la factura** (Facturas) recibe el espejo:

1. **Factura.** Total · aplicado · **disponible** grande · PUE/PPD · moneda.
2. **Aplicaciones.** Tabla: fecha · movimiento (contraparte · cuenta ·
   **enlace a la mesa**, que ya funciona: `/bancos?year=&month=&tx=`) · monto
   · REP · quién · deshacer.
3. **REP.** Parcialidades emitidas con su saldo insoluto, la siguiente que
   tocaría y su plazo; «emitir» enlaza al centro de complementos.

**Tipografía y aire.** Fichas con 16 px de padding, cuerpo 13.5 px, dinero en
mono 15 px, cabeceras de tabla 11.5 px en versalitas. Las tres tarjetas de
estadística de arriba se quedan como resumen del mes; el detalle deja de
vivir en cuadros de 100 px.

---

## 5. La herramienta de aplicar: un solo modelo para los cuatro casos

El modelo de datos **ya es N↔N**: `ConciliacionDetalle` liga cualquier
movimiento con cualquier factura por un monto, único por par. Los cuatro
casos —1 depósito → 1 factura, parte de 1 → 1, N depósitos → 1 factura, 1
depósito → N facturas— son el mismo escrito, con distinta cardinalidad. Lo
que falta es una interfaz que no obligue a elegir de qué lado se empieza.

**El asignador.** Dos columnas y una rejilla:

```
 MOVIMIENTOS (restante)          FACTURAS (disponible)
 01/08  ORTEGA     2,610.00      HH1440  20/08   6,468.97
 15/08  ORTEGA     3,858.97      HH1452  02/09   1,200.00
 ───────────────────────────     ───────────────────────────
 disponible 6,468.97             por cubrir 7,668.97

           HH1440      HH1452
 01/08    [2,610.00]  [      ]      restante 0.00
 15/08    [3,858.97]  [      ]      restante 0.00
          ─────────   ─────────
 cubierto  6,468.97    0.00 → queda abierta (PPD)
```

- **Se entra desde cualquier lado**: desde un movimiento (la charola de hoy:
  1 × N), desde una factura («Aplicar cobros» en el cajón: N × 1, nuevo), o
  desde una selección en la lista (N × N; el lote ya existe para
  categorizar — se extiende a aplicar).
- **Rellenos automáticos, todos editables**: *exacto* (el pago junto de hoy:
  subconjunto que suma al centavo), *cronológico* (la factura más vieja
  primero, el movimiento más viejo primero), *proporcional*. Cada celda es un
  número que se puede tocar; los totales de fila y columna se recalculan.
- **Los sobrantes se nombran, no se esconden**: lo que quede en un movimiento
  → chip «→ anticipo» explícito; lo que quede en una factura PPD → «queda
  abierta, parcialidad N de …»; en una PUE → aviso (una PUE no se paga en
  partes) y el guard lo rechaza si se insiste.
- **Guardas**: las de hoy, sin tocar — `checkInvoiceMatchGuard` (PUE/PPD,
  tolerancia de un centavo) y `checkSumaAsignada`. La rejilla no puede pedir
  al servidor nada que el servidor no aceptaría.
- **Escritura**: `match-multiple` ya cubre 1 × N. Faltan `PATCH
  /api/facturas/[id]/aplicaciones` (N × 1) y `POST /api/bancos/aplicaciones`
  (N × N, transaccional: todo o nada, con las mismas guardas). Las tres
  escriben `ConciliacionDetalle`; el 1:1 viejo deja de crearse (sigue
  leyéndose).
- **Nombres**: el botón por renglón «Conciliar» pasa a **«Aplicar todo»**;
  la herramienta se llama **Aplicar**. «Conciliar» queda para el acto de dar
  el mes por cuadrado (`ConciliacionBancaria`), que es otra cosa.

---

## 6. Orden de construcción

0. `lib/bancos/aplicaciones.ts` (modelo de lectura + tri-estado + REP por
   aplicación) con pruebas puras. Sin UI todavía. *Es la base de todo.*
1. Mesa: renglón con barra y tri-estado; resolver con las fichas Movimiento y
   Aplicaciones (los datos ya llegan: `cruce`, `cep`).
2. Facturas: el cajón espejo (Factura · Aplicaciones · REP) sobre el mismo
   modelo; enlace a la mesa por aplicación.
3. N × 1: «Aplicar cobros» desde la factura, con su endpoint.
4. N × N: el asignador con rellenos; endpoint transaccional; entrada desde la
   selección de la lista.
5. Archivo (Movimientos) y estado de cuenta leen `aplicaciones` en vez de
   sumar por su cuenta; se retira el cálculo duplicado.

Cada paso deja el producto usable; 0-2 se pueden entregar sin tocar la
escritura.

## 7. Lo que este diseño NO decide

- **Si el 1:1 viejo se migra** a `ConciliacionDetalle` (una fila por vínculo
  con `montoAsignado = |monto|`). Simplifica todas las lecturas; toca datos
  históricos. Se decide con un conteo de cuántos hay.
- **Anticipos como entidad propia** (con saldo y aplicaciones) vs. como tag
  del movimiento. Hoy es tag; el asignador lo enseña como sobrante nombrado.
  Si se quiere aplicar un anticipo a un CFDI de otro mes, necesita entidad.
