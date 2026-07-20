# Módulo PURIFICADORA — venta de agua purificada

**Qué es:** el vertical para negocios de purificación/venta de agua (garrafones).
Sigue el patrón de apps satélite documentado en
[INTEGRATION-GUIDE-SATELLITE-APPS.md](./INTEGRATION-GUIDE-SATELLITE-APPS.md):
contabilidad-os es el hub (auth, clientes, CFDI, bancos, conciliación, mayor) y
el frontend vive en el repo **`purificadora`** (SPA React/Vite, sin base de
datos ni auth propios).

## Qué es dato del módulo y qué es canónico

| Dato | Dueño | Superficie |
|---|---|---|
| Ventas de garrafón (por cliente), gastos de operación, catálogo de productos, config | **Este módulo** | `/api/purificadora/*` |
| Clientes | Hub (`Customer`) | `/api/clientes` (bearer-aware) |
| Facturas CFDI | Hub (`Invoice`) | `/api/facturas` (bearer-aware) |
| Cuentas bancarias, movimientos y conciliación | Hub (`BankAccount`/`BankTransaction`) | `/api/bancos/*` (bearer-aware) |
| Mayor contable | Hub (`AccountingEntry`) | vía helpers en `src/lib/accounting/postings.ts` |

## Modelos (prisma/schema.prisma → "Module: Purificadora")

- `PurifConfig` — 1:1 por empresa: precio de lista del garrafón, tasa de IVA
  default (0: el agua en envases > 10 L es tasa 0%, Art. 2-A LIVA).
- `PurifProducto` — catálogo (recarga, garrafón nuevo, botella, hielo…). El
  campo `garrafones` es el factor de garrafones físicos por unidad vendida —
  con eso el conteo de "garrafones por cliente" no depende de nombres.
- `PurifVenta` / `PurifVentaItem` — la venta (mostrador o reparto), con folio
  consecutivo `V-####`, forma de pago (EFECTIVO/TRANSFERENCIA/TARJETA/CREDITO)
  y estado (COBRADA/PENDIENTE/CANCELADA). Una venta a crédito nace PENDIENTE y
  acumula el saldo del cliente hasta el cobro. Opcionalmente se liga al CFDI
  (`invoiceId`) y al movimiento bancario que la cobró (`bankTransactionId`).
- `PurifGasto` — gastos de operación por categoría (agua cruda, luz, filtros,
  mantenimiento, sueldos, renta, combustible, otro).

## Asientos contables (postings.ts)

| Evento | Asiento |
|---|---|
| Venta (contado) | DR 1100 Caja / 1101 Bancos · CR 4170 Ingresos agua purificada (+ CR 2102 IVA si > 0) |
| Venta (crédito) | DR 1103 Cuentas por cobrar · CR 4170 (+ CR 2102) |
| Cobro de crédito | DR 1100/1101 · CR 1103 |
| Cancelación | asiento espejo de lo posteado (venta y, si hubo, cobro) |
| Gasto (contado) | DR 5203 Gastos de operación purificadora · CR 1100/1101 |
| Gasto (crédito) | DR 5203 · CR 2104 Acreedores diversos |

`fuente = PURIFICADORA`; `referenciaTipo ∈ {PURIF_VENTA, PURIF_VENTA_COBRADA,
PURIF_VENTA_CANCELADA, PURIF_GASTO}`.

## API (`/api/purificadora/*`, bearer + CORS)

Todas requieren `requireMembership(companyId, …, req)` +
`requireModule(companyId, "PURIFICADORA", req)`; las de escritura usan
`requireWriter`.

```
GET  /api/purificadora/config?companyId=
PUT  /api/purificadora/config
GET  /api/purificadora/productos?companyId=[&all=true]
POST /api/purificadora/productos
PATCH /api/purificadora/productos/[id]
GET  /api/purificadora/ventas?companyId=[&from=&to=&customerId=&estado=&take=&skip=]
POST /api/purificadora/ventas            ← venta + partidas + asiento, atómico
GET  /api/purificadora/ventas/[id]
PATCH /api/purificadora/ventas/[id]      ← {action: "cobrar"|"cancelar"|"vincular-factura"}
GET  /api/purificadora/gastos?companyId=[&from=&to=&categoria=]
POST /api/purificadora/gastos            ← gasto + asiento, atómico
GET  /api/purificadora/dashboard?companyId=
GET  /api/purificadora/clientes/resumen?companyId=   ← garrafones/saldo por cliente

# Corte del día (el talón del chofer, digital)
GET  /api/purificadora/rutas?companyId=              ← rutas/repartidores
POST /api/purificadora/rutas · PATCH /rutas/[id]
GET  /api/purificadora/sucursales?companyId=[&customerId=]  ← puntos de entrega
POST /api/purificadora/sucursales · PATCH /sucursales/[id]
GET  /api/purificadora/clientes/config?companyId=    ← precio de garrafón por cliente
PUT  /api/purificadora/clientes/config
GET  /api/purificadora/cortes?companyId=[&from=&to=&estado=]
POST /api/purificadora/cortes                        ← borrador del día
GET|PUT|DELETE /api/purificadora/cortes/[id]         ← editar/borrar mientras BORRADOR
POST /api/purificadora/cortes/[id]/confirmar         ← genera ventas (casas por ruta en
                                                       efectivo/transferencia; empresas a
                                                       crédito con partida por sucursal al
                                                       precio pactado), gastos y asientos

# Reportes (las vistas del Excel de cortes)
GET  /api/purificadora/reportes/matriz?companyId=&year=&month=[&customerId=]
     ← garrafones por día: empresa × día, o sucursal × día de un cliente
GET  /api/purificadora/reportes/estado-cuenta?companyId=&customerId=&year=&month=
     ← consumo mensual por sucursal + datos para timbrar el CFDI del consumo
GET  /api/purificadora/reportes/resumen?companyId=&year=
     ← ingresos/garrafones por cliente por mes + gastos por mes
```

El satélite factura el consumo mensual llamando `POST /api/facturas` con las
claves SAT de `PurifConfig` (claveProdServ/claveUnidad/descripcionFactura) y
`Idempotency-Key = purif-consumo-<customerId>-<year>-<month>`, y vincula las
ventas del mes al CFDI con `PATCH /ventas/[id] {action: "vincular-factura"}`.

## Puesta en marcha

1. `npx prisma db push` (dev) — ya está en schema.prisma.
2. Habilitar el módulo: `node scripts/enable-purificadora-module.mjs <RFC>`.
3. Validar postings contra la BD: `node scripts/validate-purificadora-postings.mjs`.
4. Agregar el origen del satélite a `API_ALLOWED_ORIGINS` en Railway
   (p. ej. `https://purificadora.vercel.app,http://localhost:5173`).
5. En el repo `purificadora`: `VITE_API_URL` apuntando al hub, `npm run dev`.

El matcher de CORS en `src/middleware.ts` ya incluye `/api/purificadora/*` y
las superficies canónicas que el satélite consume (`/api/clientes`,
`/api/bancos/*`, `/api/facturas`).
