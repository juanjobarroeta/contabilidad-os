# Handoff — piso inflado e ingesta de CFDIs (MARGOM)

Estado al **2026-08-14 20:15 UTC**. Escrito para que una sesión nueva —en
terminal, con `psql`— arranque sabiendo lo que ya se midió y, sobre todo, lo que
ya se descartó.

`companyId = cmsjf1wna003kn70fb68bqhm4` · `RFC = AMA170817NK1` · opera desde
**2017-08**.

---

## El hilo conductor

> «the numbers must be right, not duplicated, every cfdi accounted for and
> catalogued the right way.»

Lo que se repite en cada medición: **los libros del contador tienen razón; el
padrón está mal.** La balanza (Anexo 24, presentada al SAT) cuadra al centavo.
El inventario derivado de CFDIs no.

---

## Dónde está el piso hoy

| | unidades | costo |
|---|---|---|
| Piso en la mañana | 1,324 | $558,533,750.55 |
| Ventas empatadas hoy | −368 | −$168,397,763.53 |
| Compras nuevas de hoy | +76 | +$30,169,927.52 |
| **Piso ahora** | **1,032** | **$420,305,914.54** |
| Libros (1301/1302/1312) | — | ~$147,524,849.52 |
| **Hueco** | — | **~$272,780,000** |

Las dos definiciones de «en piso» coinciden exactamente (1,032 / $420,305,914.54):
`ventaInvoiceId IS NULL` y `fechaVenta IS NULL`. No hay ventas a medio ligar.

**El piso bajó $138.2M solo hoy** y nadie lo estaba midiendo: la repesca del SAT
(2024-01 de 57 a 2,690 facturas; +1,484 en 2025-04) trajo CFDIs de VENTA de
unidades que seguían en piso, y `derivarVehiculoInline` las empató. O sea que el
padrón se infla **porque faltan documentos**, no por mala lógica de empate.

Composición del piso (todas, sin excepción, `estado = DISPONIBLE` y
`autoCreado = true` — nada capturado a mano, `estado` no se mantiene como ciclo
de vida):

| año compra | unidades | costo |
|---|---|---|
| 2026 | 385 | $168,010,098.24 |
| 2025 | 110 | $43,017,339.35 |
| 2024 | 109 | $65,261,931.04 |
| 2023 | 135 | $44,269,879.98 |
| 2022 | 256 | $87,302,234.60 |
| 2021 | 37 | $12,444,431.32 |

El renglón que grita es **2022: 256 unidades, $87.3M, cuatro años «disponibles»**.
Una agencia no guarda inventario de 2022.

---

## Causas DESCARTADAS midiendo (no re-proponer)

| hipótesis | resultado |
|---|---|
| Cancelaciones sin revertir | `candidatas: 0` |
| Ocho meses de ingesta rotos | seis estaban sanos; sólo 2 lo estaban de verdad |
| Empate con el VIN | 98 huérfanas / $39,384,431.92 — no alcanza |
| Ciclos duplicados (mismo VIN, varios `ciclo`) | **0 unidades** |

La quinta —**faltan CFDIs de venta**— es la que sí tiene evidencia: 368 unidades
se resolvieron hoy justo por eso.

---

## Cuidado con esta trampa (ya costó tres errores)

Escribir la consulta antes de leer de dónde sale el dato. Tres veces hoy:

1. `satDijo` sumaba **todas** las solicitudes FINISHED del mes; `submitSatSync`
   crea una fila nueva por re-pedido → doble conteo.
2. La fila del mes completo **y** sus tramos cubren los mismos días → doble
   conteo otra vez.
3. Se buscó el VIN en `InvoiceItem.descripcion`. **Las facturas de VENTA no
   traen el VIN ahí** — lo traen en el complemento `ventavehiculos:VentaVehiculos`
   dentro del `rawXml`. Está documentado en `src/lib/automotriz/vin.ts:10-12`.

Regla que salió de esto: **cuando un cociente sale exacto (0.5, 2.0), no son
datos, es aritmética.** Y: leer la fuente **antes** de la consulta, no después
de un resultado sospechoso.

---

## Consultas que sirven (probadas en psql)

Piso por año, con la composición que importa:

```sql
SELECT EXTRACT(YEAR FROM COALESCE(v."fechaCompra", i."fecha", v."createdAt"))::int AS anio,
       v."estado", v."tipo", v."autoCreado",
       COUNT(*) AS unidades, SUM(v."costoCompra")::numeric(16,2) AS costo
FROM "Vehiculo" v
LEFT JOIN "Invoice" i ON i."id" = v."compraInvoiceId"
WHERE v."companyId" = 'cmsjf1wna003kn70fb68bqhm4' AND v."ventaInvoiceId" IS NULL
GROUP BY 1,2,3,4 ORDER BY 1 DESC, unidades DESC;
```

¿La unidad se vendió y no se ligó? El VIN va en el **complemento**, no en la
descripción:

```sql
WITH nivs_vendidos AS (
  SELECT DISTINCT (regexp_matches(i."rawXml", '(?i)niv="([A-HJ-NPR-Z0-9]{17})"', 'g'))[1] AS vin
  FROM "Invoice" i
  WHERE i."companyId" = 'cmsjf1wna003kn70fb68bqhm4'
    AND i."tipo" = 'INGRESO' AND i."rawXml" ILIKE '%VentaVehiculos%'
)
SELECT COUNT(*) FILTER (WHERE n.vin IS NOT NULL) AS vendido_no_ligado,
       COUNT(*) FILTER (WHERE n.vin IS NULL)     AS sin_venta
FROM "Vehiculo" v
LEFT JOIN nivs_vendidos n ON n.vin = v."vin"
WHERE v."companyId" = 'cmsjf1wna003kn70fb68bqhm4' AND v."ventaInvoiceId" IS NULL;
```

---

## Ingesta de CFDIs

**SAT (descarga masiva).** 181,423 facturas nuestras contra 187,995 que el SAT
dice que existen en los 58 meses que cubre = **~96.5%**. El 5002 («solicitudes
de por vida») se cuenta por **(RFC + rango + tipo)**, así que partir el mes en
tramos es otra llave — es la salida cuando un mes ya está quemado
(`src/lib/sat-tramos.ts`, cron `sat-repesca` con `tramos=2`). Tope duro: **cinco
años**. 2017–2021 no se puede pedir.

**Syntage.** Extracción completa terminada: **109,646 CFDIs**, de 2017-11 a hoy.
Menos que los nuestros en total, así que **no es un superconjunto**: su valor
está concentrado en el hueco pre-2021.

Tres cosas que costaron un PR cada una:

- El endpoint `/entities/{id}/invoices` **sólo acepta paginación por cursor**
  (`id[lt]` + header `X-Pagination-Style: cursor`), y **sin** `order[...]` — el
  cursor avanza por `id`. `page` devuelve 400.
- `itemsPerPage` topa en **100**. Pedir 1000 devuelve 400.
- Un CFDI **cancelado pierde el XML pero no el renglón**: el listado sigue
  trayendo su `status`. Es la única vía a las cancelaciones de 2017–2021.

`/api/cron/syntage-cfdis` — lista gratis; `extraer=1` cuesta (~$10–23 MXN);
`importar=1` escribe. Lista blanca cerrada por RFC (**sólo AMA170817NK1**).
Duplicados imposibles por `@@unique([companyId, uuid])`.

**Un solo importador:** `importarCfdiXml` (`src/lib/cfdi-import.ts`). Lo usan la
descarga masiva y Syntage. No escribir un segundo.

---

## Restricciones vigentes

- **No abrir la red ni crear un endpoint SQL genérico.** La base tiene facturas,
  clientes y nómina de personas reales. El acceso desde terminal va por el túnel
  de `railway connect`, con credenciales en la máquina del usuario.
- Usar el rol **`claude_ro`** (sólo lectura) para explorar.
- **Pendiente del usuario (no lo puede hacer Claude):** rotar `CRON_SECRET`, el
  password de Postgres y el de `claude_ro` — los tres se expusieron en el hilo.
- Las reparaciones se envían **como código, en PRs con pruebas**. Desde la
  terminal se lee y se diagnostica; no se escribe a producción por shell.

---

## Lo que sigue

1. Correr la consulta del complemento (arriba) y partir el piso en dos:
   **vendido-no-ligado** (defecto de empate, se arregla en código) contra
   **sin documento de venta** (hueco de ingesta → decide si vale la pena
   importar 2017–2021 de Syntage).
2. Si queda residuo grande, **leer historias de VINs concretos de punta a punta**
   — no otro agregado. La cohorte 2022 es por donde empezar.
3. `porAnio` de `syntage-cfdis`: `enSyntage` vs `yaTenemos` vs `faltan`, con
   `canceladasNoRegistradas`.
4. Plan CE-first aprobado y sin empezar (`docs/` + tareas #16/#13/#10): los
   estados financieros deben leer la balanza presentada, no el motor de posteo.
