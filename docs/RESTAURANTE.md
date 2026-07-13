# Módulo RESTAURANTE — RestauranteOS

Satélite de gestión de restaurantes (repo `juanjobarroeta/RestauranteOS`,
React/Vite SPA) integrado según
[`INTEGRATION-GUIDE-SATELLITE-APPS.md`](./INTEGRATION-GUIDE-SATELLITE-APPS.md):
sin base de datos propia, sin auth propio, sin lógica contable propia. Todo
vive en el hub, gated por `CompanyModule(modulo = RESTAURANTE)`.

## Qué cubre v1

| Área | Qué hace | Dónde |
|---|---|---|
| **Insumos** | Catálogo con unidad, stock, stock mínimo y **costo promedio móvil** (se recalcula al recibir compras) | `RestInsumo`, `/api/restaurante/insumos` |
| **Compras** | OC a proveedor (canónico `Supplier`): `BORRADOR/ORDENADA → RECIBIDA → PAGADA`. Recibir alimenta inventario + libro; pagar liquida el pasivo | `RestCompra*`, `/api/restaurante/compras` |
| **Menú** | Categorías + platillos con **recetas** → costeo teórico, margen y food-cost % contra el costo promedio vigente | `RestMenuItem`, `RestReceta`, `/api/restaurante/menu/*` |
| **Comandas** | Órdenes MESA/LLEVAR/DOMICILIO; partidas con precio congelado; agregar partidas, cancelar | `RestOrden*`, `/api/restaurante/ordenes` |
| **Cocina (KDS)** | Cola por estación (COCINA/BARRA/POSTRES); `PENDIENTE → EN_PREPARACION → LISTO → ENTREGADO` por partida | `/api/restaurante/cocina` |
| **Cobro** | Money-loop: desglose IVA (precios IVA-incluido), propina como pasivo, descarga de inventario por receta, costo de venta teórico | `/ordenes/[id]/cobrar` |
| **Facturación** | El POS timbra contra el endpoint existente `POST /api/facturas` (Facturapi, bearer-aware, idempotente) y liga el CFDI a la orden vía `PATCH /ordenes/[id] { invoiceId }` | hub existente |
| **Dashboard** | Ventas del día, food cost real, propinas, top platillos, insumos bajo mínimo, compras por pagar | `/api/restaurante/dashboard` |

## Asientos contables (`src/lib/accounting/postings.ts`)

Cuentas nuevas en `DEFAULT_ACCOUNTS` (auto-creadas al primer uso):
`1107 Almacén de insumos`, `1118 IVA acreditable`, `2107 Propinas por pagar`,
`4160 Ingresos por alimentos y bebidas`, `5103 Costo de alimentos y bebidas`.

| Evento | Asiento |
|---|---|
| Compra **recibida** | DR 1107 (subtotal) + DR 1118 (iva, si > 0) / CR 2104 (total) |
| Compra **pagada** | DR 2104 / CR 1100 Caja ó 1101 Bancos |
| Orden **cobrada** | DR 1100/1101 (total+propina) / CR 4160 (subtotal) + CR 2102 (iva) + CR 2107 (propina) |
| **Costo de venta** | DR 5103 / CR 1107 (costo teórico por recetas; también en CORTESIA) |

`fuente = RESTAURANTE`; `referenciaTipo ∈ {REST_COMPRA_RECIBIDA,
REST_COMPRA_PAGADA, REST_ORDEN_COBRADA, REST_COSTO_VENTA}`.

Notas:
- La propina **no** es ingreso (pasivo 2107) y no lleva IVA.
- El IVA de compras se captura explícito (muchos insumos alimentarios son
  tasa 0%). La acreditación fiscal efectiva la deriva el motor fiscal desde
  los CFDIs, como en el resto del hub — estos asientos son el libro operativo.
- `CORTESIA` no postea ingreso ni crea BankTransaction, pero sí descarga
  inventario y postea el costo (la comida salió de la cocina).

## Operación

```bash
# Habilitar el módulo en una empresa
node scripts/enable-restaurante-module.mjs <RFC>

# Validar los postings contra la BD de dev
set -a; . ./.env.local; set +a
node scripts/validate-restaurante-postings.mjs   # "✅ All checks passed"
```

Deploy checklist (una vez, por entorno):
1. `prisma db push` (nuevas tablas Rest* + enums).
2. `API_ALLOWED_ORIGINS` += origen del satélite (p. ej.
   `https://restauranteos.vercel.app`) — sin espacios ni slash final.
3. Habilitar el módulo en la(s) empresa(s) piloto.
4. El satélite necesita `VITE_API_URL` apuntando al hub.

El matcher de CORS (`src/middleware.ts`) incluye `/api/restaurante/:path*` y
`/api/facturas(/:path*)` — este último para que el POS timbre directo (el
endpoint ya era bearer-aware; CORS sólo aplica a orígenes de la allowlist).
