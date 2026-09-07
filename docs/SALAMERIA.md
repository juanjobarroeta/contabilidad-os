# Módulo SALAMERIA — importadora y distribuidora de abarrote gourmet

**Qué es:** el vertical para quien IMPORTA y DISTRIBUYE producto con caducidad,
y además lo vende en línea. Primer cliente: **MERCEDES TRESPALACIOS**
(«La Salamería — mercado de delicias», `lasalameriadeli.com`), persona física
que trae repostería gourmet de Europa —Lotus Biscoff, Callebaut, Nutella,
Kataifi, Maldon— y la vende a pastelerías y cafeterías al mayoreo y al público
en línea.

Sigue el patrón de apps satélite de
[INTEGRATION-GUIDE-SATELLITE-APPS.md](./INTEGRATION-GUIDE-SATELLITE-APPS.md):
contabilidad-os es el hub (auth, clientes, proveedores, CFDI, bancos,
conciliación, mayor, impuestos) y el frontend vive en el repo **`Salameria`**
(React/Vite, **dos builds** desde un mismo código: ADMIN y TIENDA). Módulo:
`CompanyModule(modulo = SALAMERIA)`; API: `/api/salameria/*` (bearer + CORS).

## La cadena del producto

```
IMPORTACIÓN ──▶ ALMACÉN ──▶ PEDIDO ──▶ FACTURA ──▶ BANCO ──▶ CONTABILIDAD
pedimento y     lote con    tienda o    hub         hub       hub
costeo          caducidad   mostrador
   módulo         módulo      módulo      hub         hub        hub
```

«Si entró por la aduana tiene costo; si tiene costo tiene lote; si tiene lote
tiene caducidad.» Los tres primeros eslabones son de este módulo; los otros
tres ya existen en el hub y **no se duplican**: la factura es un `Invoice` (se
emite con `POST /api/facturas`), el cobro se concilia en bancos, y el asiento
fiscal lo deriva el motor del hub desde los CFDIs.

## Las tres decisiones que explican todo lo demás

### 1. El lote es la verdad, no el producto

Un importador de alimentos no puede llevar un saldo por SKU. La misma caja de
Biscoff comprada en marzo y en agosto tiene **costo distinto** (otro tipo de
cambio) y **caducidad distinta**. Por eso el inventario son filas de `SalLote`
con su costo aterrizado y su fecha.

`SalProducto.stock` y `.costoPromedio` son un **espejo** derivado, para poder
listar 400 SKUs sin agregar lotes en cada consulta. Si el espejo y los lotes se
contradicen, **gana el lote**.

La salida es **FEFO** (*first expired, first out*), no FIFO: sale primero lo que
primero vence. En abarrote casi siempre coinciden — pero no cuando llega un
lote de remate con caducidad corta, que tiene que salir antes que el que ya
estaba o se convierte en merma.

### 2. El IVA de importación no es costo

Todo lo que paga el pedimento —flete internacional, arancel, DTA, agente
aduanal, maniobras— se prorratea al costo de cada caja. El **IVA pagado en
aduana es acreditable**: se va a `1118`, nunca al inventario. Prorratearlo —el
error clásico del importador— infla el almacén 16 % y hace que el estado de
resultados reporte un margen que no existe.

Está en el esquema (`SalImportacionCosto.prorratea`), en el default por tipo de
costo (`POST …/costos`), y en el asiento (`postImportacionLiberada` separa
`costoMercancia` de `ivaImportacion`).

### 3. El anticipo de preventa no es ingreso

La cubeta de Lotus se vende en marzo (`PRE ORDER` en la tienda) y llega en
junio. Ese dinero es **pasivo** (`2103 Anticipos de clientes`) hasta que se
entrega. Reconocerlo como venta al cobrarlo adelanta utilidad de un ejercicio a
otro y deja el mes inventado.

`postAnticipoSalameria` lo abona a 2103; `postVentaSalameria` lo **carga** de
vuelta al entregar, en vez de volver a tocar el banco (el dinero ya entró).

## Cada costo se reparte por su propia base

| Costo | Base | Por qué |
|---|---|---|
| Flete internacional, flete nacional, maniobras | **PESO** | Se paga por mover volumen |
| Arancel, seguro, agente aduanal, DTA, almacenaje | **VALOR** | Se cobran sobre el valor declarado |
| IVA de importación | — | **No prorratea**: acreditable (1118) |

Una sola base para todo le carga el flete al producto caro y ligero (praliné de
pistache, 1 kg a 90 USD) y se lo perdona al barato y pesado (cubeta de Lotus,
8 kg a 120 USD) — exactamente al revés. Con reparto por peso la cubeta paga
$800 de flete y el praliné $100; por valor pagarían $618 y $232. Ver
`src/lib/salameria/costeo.test.ts`, que fija ese caso.

El reparto **cuadra al centavo**: los redondeos se ajustan dándole el residuo a
la partida más grande. Sin eso la suma de los costos de los lotes no es igual
al asiento y el almacén queda descuadrado por centavos que nadie encuentra.

## Precios: una sola fuente de verdad

No hay un `precio` en el producto **y además** listas que lo modifican. **Todo
precio es un renglón de `SalPrecio`.** La lista marcada `publica` (el menudeo)
es la base; las de mayoreo se derivan de ella por descuento general o la pisan
renglón por renglón.

Prioridad al resolver un precio, para una cantidad dada:
1. Renglón explícito en la lista del cliente (gana siempre).
2. Descuento general de esa lista sobre el precio público.
3. El precio público.

Con **quiebre por volumen**: aplica el renglón de mayor `minimo` que la cantidad
alcanza (1 pz → $499; 12 pz → $460).

**Consecuencia aceptada:** un producto sin renglón en la lista pública no tiene
precio y no se puede vender. Es deliberado —vender a un precio inventado es
peor que no vender— y el panel lo saca en «Publicados sin precio».

## Qué es dato del módulo y qué es canónico

| Dato | Dueño | Superficie |
|---|---|---|
| Productos, lotes, kardex | **Módulo** (`SalProducto`, `SalLote`, `SalMovimiento`) | `/api/salameria/productos`, `/almacen/*` |
| Importaciones, pedimento, costeo | **Módulo** (`SalImportacion`, `SalImportacionItem`, `SalImportacionCosto`) | `/api/salameria/importaciones/*` |
| Compras nacionales | **Módulo** (`SalCompra`, `SalCompraItem`) | `/api/salameria/compras` |
| Listas y precios | **Módulo** (`SalListaPrecio`, `SalPrecio`) | `/api/salameria/listas/*` |
| Cuentas de la tienda | **Módulo** (`SalCuenta`) | `/api/salameria/cuentas`, `/tienda/login` |
| Pedidos, pagos, envíos | **Módulo** (`SalPedido`, `SalPedidoPartida`, `SalPago`, `SalEnvio`) | `/api/salameria/pedidos/*`, `/tienda/*` |
| Clientes y proveedores (directorio fiscal) | Hub (`Customer`, `Supplier`) | `/api/clientes/*`, `/api/proveedores/*` |
| Facturas CFDI | Hub (`Invoice`) | `POST /api/facturas` |
| Bancos y conciliación | Hub (`BankAccount`/`BankTransaction`) | `/api/bancos/*` |
| Estado de resultados, balance | Hub (CE presentada + libro derivado) | `/api/contabilidad/ce-*` |
| Impuestos del mes | Hub (`computeTaxPosition`) | `/api/impuestos/*` |

`CompanyMember.salameriaPaginas` — rejilla de páginas visibles del satélite
(`[]` = todas), mismo contrato que `automotrizPaginas` y `hospitalPaginas`.

## Modelos (prisma/schema.prisma → "Module: Salamería")

- `SalConfig` — 1:1 por empresa: series de folio (`PED`, `OC`, `IMP`), IVA
  default (**0**, porque el abarrote es tasa 0 % — Art. 2-A LIVA), días de
  alerta de caducidad (90), regla de envío de la tienda y % de anticipo de
  preventa.
- `SalProducto` — el SKU, con `slug` para la URL de la tienda, `pesoKg` (lo que
  prorratea el flete y cotiza la paquetería), claves SAT para que la factura
  salga sola, y las banderas `publicado` / `destacado` / `preventa`.
- `SalLote` — una fila por lote físico: `cantidad` (lo que queda),
  `costoUnitario` (aterrizado, ya no cambia) y `caducidad`.
- `SalMovimiento` — kardex con signo. Nunca se edita ni se borra; una
  corrección es un `AJUSTE` nuevo. Filtrando por `loteId` sale a qué pedidos se
  fue un lote — la respuesta que hay que dar en horas ante una alerta sanitaria.
- `SalCompra` + `SalCompraItem` — compra nacional. `ORDENADA → RECIBIDA → PAGADA`.
- `SalImportacion` + `SalImportacionItem` + `SalImportacionCosto` — el
  contenedor, con `pedimento`, `aduana` y `tipoCambio` **congelado** (el costo
  del inventario no puede moverse cuando se mueve el dólar).
- `SalListaPrecio` + `SalPrecio` — ver «Precios» arriba.
- `SalCuenta` — la sesión del comprador (audiencia `salameria:tienda`), con su
  lista de precios y su crédito. `customerId` opcional: quien compra al menudeo
  puede no querer factura, y exigirle RFC para agregar al carrito es la forma
  más rápida de perder la venta.
- `SalPedido` + `SalPedidoPartida` — el pedido venga de donde venga. `CARRITO`
  es el carrito vivo (una fila, no otra tabla): al pagar cambia de estado y ya
  es pedido, sin copiar nada. Los precios se **congelan** en la partida;
  `lotesSurtidos` (JSON) guarda de qué lotes salió cada cosa.
- `SalPago` — un cobro contra el pedido. `referenciaExterna` es **único**: es lo
  que hace idempotente el webhook de la pasarela.
- `SalEnvio` — paquetería, guía y el costo que la paquetería cobra (distinto de
  lo que se le cobró al cliente).

## Asientos contables (`src/lib/accounting/postings.ts`)

Cuentas nuevas en `DEFAULT_ACCOUNTS` (se crean solas al primer uso):
`1108 Almacén de mercancías`, `1109 Mercancía en tránsito`,
`4190 Ingresos por venta de mercancía`, `4191 Ingresos por envío`,
`5120 Costo de mercancía vendida`, `5121 Mermas y caducidades`,
`5207 Fletes y paqueterías`.

| Evento | Asiento |
|---|---|
| Importación **liberada** | DR 1108 (costo aterrizado) + DR 1118 (IVA aduana) / CR 2104 |
| Compra nacional **recibida** | DR 1108 (subtotal) + DR 1118 (iva) / CR 2104 |
| Compra **pagada** | DR 2104 / CR 1100 Caja ó 1101 Bancos |
| **Anticipo** de preventa | DR 1100/1101 / CR 2103 Anticipos de clientes |
| Pedido **entregado** | DR 1100/1101/1103 (lo que falte) + DR 2103 (lo anticipado) / CR 4190 + CR 4191 + CR 2102 |
| **Costo de venta** | DR 5120 / CR 1108 (costo del lote FEFO que salió) |
| **Merma / caducidad** | DR 5121 / CR 1108 |
| Envío pagado a paquetería | DR 5207 / CR 1100/1101 |

`fuente = SALAMERIA`; `referenciaTipo ∈ {SAL_IMPORTACION_LIBERADA,
SAL_COMPRA_RECIBIDA, SAL_COMPRA_PAGADA, SAL_ANTICIPO, SAL_PEDIDO_ENTREGADO,
SAL_COSTO_VENTA, SAL_MERMA, SAL_ENVIO_PAGADO}`.

**Surtir no es cobrar.** Surtir reconoce el COSTO (5120/1108); entregar
reconoce el INGRESO (4190/4191/2102). Separarlos es lo que permite que una
preventa cobrada en marzo no se vuelva ingreso hasta que llega en junio.

**Idempotencia:** el estado de la fila fuente. Liberar dos veces, recibir dos
veces o surtir dos veces responden **409** y no tocan nada — y el chequeo se
repite DENTRO de la transacción, porque entre el filtro y el `INSERT` cabe otro
doble clic.

## La tienda

Dos superficies del mismo repo y de la misma API:

| Ruta | Sesión | Qué hace |
|---|---|---|
| `GET /tienda/catalogo` | **pública** (token opcional) | El escaparate. Con token, precios de mayoreo |
| `GET /tienda/producto/[slug]` | **pública** (token opcional) | La ficha que se comparte e indexa |
| `POST /tienda/registro` | pública | Alta de comprador al **menudeo** |
| `POST /tienda/login` | pública | Emite el token `salameria:tienda` |
| `GET/PUT /tienda/carrito` | cuenta | El carrito. El PUT manda la lista **completa** |
| `POST /tienda/checkout` | cuenta | Carrito → pedido. Re-resuelve y congela precios |
| `GET /tienda/pedidos` | cuenta | «Mis pedidos», acotado al `cuentaId` del token |

Lo que **nunca** sale por la tienda, aunque esté en la fila: costo, costo
aterrizado, margen, **existencia exacta** (sólo `disponible: boolean` —
publicar «quedan 3» deja leer el inventario completo con un script), lotes y
proveedores.

Las rutas públicas están declaradas en `src/lib/api-guardias.allowlist.ts` con
su razón. `verifySalTiendaToken` **no** está en la lista de `AUTENTICADORES` del
test de guardias, a propósito: el catálogo y la ficha lo usan de forma
*opcional*, y listarlo haría que esas dos rutas pasaran la Regla 1 sin que nadie
revisara que son públicas queriendo. El que autentica —porque lanza 401— es
`requireSalCuenta`.

El registro público crea la cuenta **sin lista de mayoreo y sin crédito**: subir
a alguien a mayorista es una decisión de la empresa desde el ERP. Si el registro
pudiera pedir su propia lista, cualquiera se daría precio de mayoreo.

## Operación

```bash
# Habilitar el módulo (y opcionalmente prender la tienda pública)
set -a; . ./.env.local; set +a
node scripts/enable-salameria-module.mjs <RFC> --tienda

# Datos de muestra del catálogo real de La Salamería
npx tsx scripts/seed-salameria-demo.ts <RFC>

# Las funciones puras (costeo del pedimento, precios, envío)
npx vitest run src/lib/salameria/
```

Checklist de despliegue (una vez, por entorno):

1. `prisma migrate deploy` — tablas `Sal*` + enums, y `SALAMERIA` en
   `ModuloApp` / `EntrySource`. Sólo aditivo.
2. `API_ALLOWED_ORIGINS` += **los dos** orígenes del satélite: el del ADMIN y
   el de la TIENDA (sin espacios ni slash final). La tienda la llama el
   navegador de un comprador cualquiera, así que su origen también va.
3. Habilitar el módulo en la empresa.
4. Cargar catálogo y **precios en la lista pública** — sin ellos el catálogo
   sale vacío, porque un producto sin precio no se enseña.
5. Prender la tienda (`SalConfig.tiendaActiva`) hasta que 4 esté hecho.
6. El satélite necesita `VITE_API_URL` apuntando al hub y `VITE_COMPANY_ID`
   en el build de la tienda (el escaparate es de UNA empresa, no multi-RFC).

El matcher de CORS (`src/middleware.ts`) incluye `/api/salameria/:path*`, y
`/api/facturas(/:path*)` ya estaba para que el ERP timbre directo.

## Lo que falta (v2)

- **Pasarela de pago.** Hoy el pedido queda en `PENDIENTE_PAGO` y el cobro se
  registra con `POST /pedidos/[id]/pagar`. El webhook de Stripe/Mercado Pago
  llama a ese mismo endpoint con `referenciaExterna` (ya es idempotente); falta
  el handler del webhook y el checkout hospedado.
- **Cotizador de paquetería.** `SalEnvio` guarda paquetería, guía y costo, pero
  se capturan a mano. `SalProducto.pesoKg` ya está para cotizar.
- **Timbrado automático al entregar.** Hoy el CFDI se timbra en el ERP contra
  `POST /api/facturas` y se liga con `PATCH /pedidos/[id] {accion:"FACTURAR"}`.
- **Migración de Shopify.** Importar catálogo, clientes e histórico de pedidos.
- **Devoluciones.** Cancelar un pedido surtido devuelve el inventario a su lote
  original, pero **no reversa** el asiento de costo: la devolución es un hecho
  contable propio y le toca su propio asiento.
- **Conteo físico.** El espejo se recalcula desde los lotes, pero no hay
  pantalla de inventario físico que ajuste lote por lote.
