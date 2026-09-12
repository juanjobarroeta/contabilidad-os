# Mesa de conciliación — especificación para diseño

v1 · 12-sep-2026 · Fuente de datos: [DISENO-mesa-aplicaciones.md](DISENO-mesa-aplicaciones.md) y
`src/lib/bancos/aplicaciones.ts` (paso 0, en `main` desde #1031).

**Cómo leer esto.** Cada elemento trae tres cosas: qué es, qué DATO real lo
alimenta, y en qué estados puede estar. Nada aquí es inventado: todo dato
citado ya existe en el sistema. Lo que el diseño puede cambiar es cómo se ve
y en qué orden; lo que no puede cambiar es qué se muestra y qué significa.

---

## 1. Principio y vocabulario

- **La mesa DECIDE; el archivo BUSCA.** La mesa trabaja UN mes de una cuenta
  (o todas) y su meta es cuadrar a cero: cada movimiento del banco termina
  **aplicado** a facturas, aplicado a una declaración, o **categorizado** con
  etiqueta. El tab Movimientos (el archivo, todos los meses) no se retira; le
  entrega movimientos a la mesa con «Resolver en la mesa».
- **Aplicar** = ligar dinero de un movimiento con un CFDI por un importe.
  **Conciliar** = dar el mes por cuadrado (firma). Hoy hay dos botones que
  dicen «Conciliar» y hacen cosas distintas; en el diseño nuevo no puede haber
  dos.
- **Un movimiento puede aplicarse a N facturas; una factura puede recibir N
  movimientos; cualquier aplicación puede ser parcial.** El modelo ya lo
  permite. La interfaz es la que hoy no.

## 2. Mapa de la pantalla

```
┌ Tabs: Conciliación · Movimientos · Cuentas · Histórico ─────────────────────┐
│ ENCABEZADO   cuenta ▾   ‹ agosto 2026 ›   SIN APLICAR 113 · PARCIAL 4 ·      │
│              COMPLETO 279 · CATEGORIZADO 41        [Auto-conciliar] [Firmar] │
├──────────────────────────┬───────────────────────────────────────────────────┤
│ LISTA (≈45 %)            │ RESOLVER (≈55 %)                                  │
│ filtros · búsqueda       │ ┌ Ficha 1 · MOVIMIENTO ─────────────────────────┐ │
│ ☐ renglón                │ │ importe · datos · CEP · aplicado / restante   │ │
│ ☐ renglón (seleccionado) │ └───────────────────────────────────────────────┘ │
│ ☐ renglón                │ ┌ Ficha 2 · APLICACIONES ───────────────────────┐ │
│ …                        │ │ tabla: fecha · factura · monto · REP · ⨯      │ │
│ [Ver más]                │ └───────────────────────────────────────────────┘ │
│                          │ ┌ Ficha 3 · APLICAR ────────────────────────────┐ │
│                          │ │ sugerencias · búsqueda · asignador · categorías│ │
│                          │ └───────────────────────────────────────────────┘ │
└──────────────────────────┴───────────────────────────────────────────────────┘
```

Breakpoints: ≥ 1280 split como arriba; 1024–1279 split angosto (la lista a
una línea por renglón); < 1024 la lista ocupa todo y el resolver se abre en
pantalla completa con «Volver a la lista».

## 3. Encabezado del mes

| Elemento | Qué es | Dato | Estados |
|---|---|---|---|
| Cuenta | Selector: Todas / una cuenta (banco · nombre · ····últimos 4) | `BankAccount.banco, nombre, numeroCuenta` | — |
| Periodo | Mes con ‹ › | selector de periodo existente | mes firmado → candado |
| Progreso | Cuatro conteos con chip de color y % por cuenta | `estado` de `aplicaciones` por movimiento | — |
| Auto-conciliar | Botón secundario; corre el motor y reporta cuántos aplicó | acción existente | ocupado |
| Firmar el mes | Botón primario sólo cuando SIN APLICAR = 0; después la mesa queda en lectura con «Reabrir» | `ConciliacionBancaria.conciliadoAt` | disponible · firmado |

## 4. Lista de movimientos

**Renglón (56 px, dos líneas + columna de dinero):**

```
┌──────────────────────────────────────────────────────────────────────┐
│ ☐  JOSE ARMANDO ORTEGA                                    $2,610.00  │
│    01/08/26 · BBVA Cheques · 2026080140014BET…   [PARCIAL]  ▂▂▂▂▂░░░ │
└──────────────────────────────────────────────────────────────────────┘
```

- Línea 1: contraparte (`contraparteNombre`; si no hay, `descripcion`) ·
  importe firmado en mono (abono = ink, cargo = red-ink).
- Línea 2: fecha dd/mm/aa · cuenta corta · clave de rastreo en mono si
  existe · **chip de estado** (§12).
- **Barra 2 px bajo el importe = asignado / original.** Sólo se pinta en
  PARCIAL y COMPLETO. Es lo que hace que un parcial se vea desde lejos.
- Seleccionado: fondo brand-tint + rail izquierdo de 3 px (existente).
- Checkbox para selección múltiple (lote): categorizar en lote (existe) y
  **«Aplicar juntos»** (§8, nuevo).
- Filtros como chips con conteo: **Sin aplicar · Parcial · Completo ·
  Categorizado · Todos**. Búsqueda: concepto, contraparte, RFC o importe.
  «Ver más» de 80 en 80. Teclado: ↑ ↓ mueven la selección, Enter abre.

## 5. Ficha 1 · Movimiento

| Zona | Contenido | Dato |
|---|---|---|
| Importe | Original, grande (mono 28 px), firmado por color | `original` (=|monto|), signo de `monto` |
| Línea | fecha · cuenta (banco · nombre · ····1234) · chip de estado | `movimiento.*`, `estado` |
| Datos (grid 2 col) | Contraparte (nombre, RFC) · CLABE · Clave de rastreo · Concepto · Referencia | `contraparteNombre/Rfc`, `contraparteClabe`, `claveRastreo`, `conceptoPago`, `referencia` |
| Descripción cruda | La cadena del banco tal cual, plegable, en mono. Nunca se esconde del todo | `descripcion` |
| **CEP (Banxico)** | Una fila-resumen: **estado** · fecha de operación · **importe según Banxico** · ordenante → beneficiario (nombre · banco). Botón «Ver comprobante» abre el visor existente con los 12 campos. Si no hay CEP: «Pedir a Banxico» (acción existente) | `cep.*` (12 campos) |
| Aplicado / Restante | Dos cifras en mono, alineadas. Si `restante > 0` y el estado no es SIN APLICAR: chip **→ anticipo $X** | `asignado`, `restante`, `estado` |
| Notas | Texto editable | `notes` |

Casos: CEP con estado **Devuelto** → banda roja arriba de la ficha («Banxico
lo reporta devuelto»). Importe Banxico ≠ importe del banco → la cifra de
Banxico en ámbar con la diferencia.

## 6. Ficha 2 · Aplicaciones

Tabla; una fila por aplicación, cronológica.

| Columna | Contenido | Dato |
|---|---|---|
| Fecha | del movimiento (la fecha legal del cobro) | `fecha` |
| Factura | serie+folio en mono · contraparte · tipo. Click abre el cajón de la factura | `factura.*` |
| Monto | la porción, mono | `monto` |
| REP | chip: **Parcialidad N** (jade) · **Sin REP** (ámbar) · **No aplica** (PUE, apagado) | `rep.estado`, `rep.numParcialidad` |
| Registrada | fecha; quién cuando exista (hoy null: el sistema no lo guarda todavía) | `registro` |
| ⨯ | Deshacer esta aplicación (confirmación en línea, no modal) | acción existente (desconciliar) |

Variantes de fila: **impuesto** («IVA julio 2026 · pagado») cuando el
movimiento se aplicó a una declaración; **anticipo** cuando el restante quedó
etiquetado. Vacío: «Sin aplicar todavía» y la mirada baja a la ficha 3.

## 7. Ficha 3 · Aplicar

Cuatro bloques en este orden. Todos alimentan el mismo asignador.

**(a) Sugerencias.** Candidatos con confianza (alta / media / baja). Tarjeta:
serie+folio · contraparte · fecha · **disponible** (no el total) — si la
factura ya recibió abonos: «disponible $X de $Y» + chip Parcial · tag PPD ·
acciones **Ver · Agregar · Aplicar todo**. «Pago junto» (N facturas de la
misma contraparte que suman exacto) es una sugerencia especial con un solo
botón «Aplicar las N». Impuestos pendientes (sólo egresos) con «Aplicar».

**(b) Búsqueda manual.** Tabs Ingresos / Gastos / Nómina; un campo (cliente,
RFC, UUID, folio, importe); línea de hechos: «N facturas pendientes · suman
$X · disponible $Y». Resultados con las mismas tres acciones.

**(c) Asignador 1 × N (la charola).** Aparece al primer «Agregar».

```
┌ APLICAR · 2 facturas ───────────────────────────────────────────┐
│ HH1440 · ORTEGA      disponible 3,858.97 de 6,468.97   [2,610.00] ⨯ │
│ HH1452 · ORTEGA      disponible 1,200.00               [    0.00] ⨯ │
│ ─────────────────────────────────────────────────────────────── │
│ Suma asignada  2,610.00   Movimiento  2,610.00   Restante  0.00 │
│                                              [ Aplicar 2 facturas ] │
└─────────────────────────────────────────────────────────────────┘
```

- Cada línea: factura · disponible (y «de total» si es parcial) · **monto
  editable** · quitar. **Default del monto = min(disponible de la factura,
  restante del movimiento)** — un parcial arranca con el número correcto.
- Totales: suma asignada · monto del movimiento · restante.
- **Sobrantes nombrados, nunca escondidos:** restante > 0 → chip ámbar
  «→ anticipo $X» y una línea que lo dice; factura PPD que queda abierta →
  «queda abierta, parcialidad N de …».
- **Guardas visibles antes de enviar:** suma > movimiento → cifra en rojo,
  botón apagado, «La suma excede el movimiento»; PUE con monto < total →
  rojo, «Una PUE no se paga en partes».
- Botón primario: **«Aplicar N facturas»**. Ningún otro botón de esta ficha
  dice Aplicar sin número.

**(d) «o categoriza sin factura».** Las categorías y familias de lote
existentes (impuestos, nómina sin CFDI, comisión, traspaso…).

## 8. Asignador N × N

Entradas: selección múltiple en la lista → **«Aplicar juntos»**; desde una
factura → **«Aplicar cobros»** (N movimientos a 1 factura).

```
 MOVIMIENTOS (restante)      │  HH1440      HH1452   │ restante
 01/08  ORTEGA    2,610.00   │ [2,610.00]  [      ]  │    0.00
 15/08  ORTEGA    3,858.97   │ [3,858.97]  [      ]  │    0.00
 ────────────────────────────┼───────────────────────┼─────────
 cubierto                    │  6,468.97     0.00    │
                             │  completa   abierta   │
 Relleno: ( Exacto ) ( Cronológico ) ( Proporcional )      [ Aplicar ]
```

- Cada celda es un número editable; totales de fila y columna se recalculan.
- Rellenos: **Exacto** (subconjunto que suma al centavo = el pago junto),
  **Cronológico** (factura más vieja y movimiento más viejo primero),
  **Proporcional**.
- Sobrantes nombrados como en 1 × N. «Aplicar» confirma todo o nada.

## 9. Espejo en Facturas (cajón de la factura)

Tres fichas en el mismo orden mental: **Factura** (total · aplicado ·
**disponible** grande · PUE/PPD · moneda) → **Aplicaciones** (fecha ·
movimiento con cuenta y contraparte · monto · REP · «→ ver en la mesa», que
ya funciona) → **REP** (parcialidades emitidas con saldo insoluto, la
siguiente que toca y su plazo — día 5 del mes siguiente al cobro — y
«Emitir»). Datos: `aplicacionesDeFactura`.

## 10. Estados y casos que el diseño debe cubrir

| Caso | Qué se ve |
|---|---|
| PUE vs PPD | PPD lleva REP por abono; PUE muestra «No aplica». PUE no acepta parcial |
| Depósito neto (terminal) | La diferencia factura − depósito es **comisión**, no restante: línea propia «comisión $X» |
| Nota de crédito (tipo E) | Aplicación con signo negativo en la tabla |
| Moneda ≠ MXN | Tipo de cambio del día del cobro en la aplicación; disponible en la moneda de la factura |
| CEP Devuelto | Banda roja en la ficha 1; el movimiento no se puede aplicar |
| Movimiento COMPLETO | Fichas 1 y 2 en lectura; ficha 3 colapsada con «Reabrir» |
| CATEGORIZADO | Etiqueta visible + «Quitar etiqueta»; sin aplicaciones |
| Mes firmado | Toda la mesa en lectura; «Reabrir mes» en el encabezado |
| Sin cuentas | Estado vacío existente (importar estado de cuenta) |

## 11. Datos reales por elemento

| Necesidad | De dónde sale (ya existe) |
|---|---|
| original · asignado · restante · estado · aplicaciones · REP por abono · CEP · impuesto | `aplicacionesDeMovimiento(txId)` |
| total · aplicado · disponible · estado · aplicaciones · REP (parcialidades, saldo insoluto) | `aplicacionesDeFactura(invoiceId)` |
| candidatos con confianza, disponible, pago junto, impuestos | `GET /api/bancos/[id]/match` (`remainingBalance`, `matchedAmount`) |
| búsqueda manual | mismo endpoint (`q`, tabs) |
| CEP completo | `CepMovimiento` (12 campos) + visor existente |
| **quién aplicó** | **no existe todavía** — el sistema no lo guarda; el diseño lo prevé como columna que hoy va vacía |

## 12. Sistema visual (el del producto, no uno nuevo)

- **Color**: tokens en `globals.css`. Marca azul (hue 258 claro / 262 oscuro).
  Semánticos: **jade** = completo / amparado; **ámbar** = parcial / sin REP /
  atención; **rojo** = exceso / devuelto / error; **slate** = categorizado /
  apagado. El acento de marca se reserva para selección y acción primaria.
- **Chips de estado**: SIN APLICAR (slate outline) · PARCIAL (ámbar) ·
  COMPLETO (jade) · CATEGORIZADO (slate relleno).
- **Radios**: tarjeta 16 px, control 11 px. Sombra de tarjeta existente.
- **Tipografía**: Geist (texto) y Geist Mono (dinero, folios, claves, UUID).
  Dinero siempre mono, tabular, dos decimales; signo por color, no por «−».
  Título 30/−0.03em; ficha 16 px de padding; cuerpo 13.5; etiquetas 11.5 en
  versalitas con tracking.
- **Densidad**: fila de lista 56 px; tabla de aplicaciones 40 px por fila.
- **Temas**: claro y oscuro (los tokens ya existen para ambos).

## 13. Fuera de alcance / no negociable

- No se retira el tab Movimientos ni se mueve la mesa de `/bancos`.
- No cambia el modelo de datos (`ConciliacionDetalle` sigue siendo la
  relación). No se aplica nada sin confirmación explícita.
- Anticipos como entidad propia: pendiente de decidir; por ahora es el
  restante nombrado.

## 14. Criterios de aceptación

1. Un abono parcial se aplica en **dos acciones** (Agregar → Aplicar N),
   sin teclear el monto si el default es el correcto.
2. El **restante** de un movimiento parcial se ve **desde la lista**, sin
   abrirlo.
3. No hay dos controles que digan «Conciliar» con significados distintos.
4. Cada aplicación muestra su REP (o «Sin REP» / «No aplica»).
5. N × N se resuelve sin salir de la mesa.
6. Todo dato en pantalla existe en §11. Nada se inventa.
