# Handoff — inventario y archivo de CFDIs (MARGOM)

Estado al **2026-08-16**. La recuperación de documentos **terminó**. Lo que queda
ya no es un problema de datos faltantes; es de conciliación contra los libros.

`companyId = cmsjf1wna003kn70fb68bqhm4` · `RFC = AMA170817NK1` · opera desde
**2017-08**.

---

## El hilo conductor

> «the numbers must be right, not duplicated, every cfdi accounted for and
> catalogued the right way.»

---

## Dónde estamos

| | mañana del 2026-08-14 | ahora |
|---|---:|---:|
| CFDIs en la base | 182,800 | **198,162** |
| El archivo empieza en | 2021-09-01 | **2017-11-01** |
| Cobertura de EMITIDAS | (se midió mal: «100%») | **99.92%** — faltan 93 |
| Cobertura de RECIBIDAS vigentes en ventana SAT | sin medir | **100%** |
| Piso (hoy) | 1,032 u / $420,305,915 | **539 u / ~$228.7M** |
| Piso al corte de la balanza (2026-06-30) | — | **448 u / $180,677,546** |
| Libros (balanza 2026-06, cuentas 1301+1302+1312) | $147,524,850 | $147,524,850 |
| **Hueco** | **~$272,780,000** | **$33,152,697** |

**Salieron 493 unidades y ~$191.6M del piso**, todas porque llegó su documento
de venta. No se editó ni un renglón de inventario.

---

## Qué estaba roto (y ya no)

El padrón no estaba inflado por mala lógica: **faltaban meses enteros de CFDIs
emitidos**. Recuperados el 2026-08-15 vía `sat-repesca`:

| mes | emitidas que faltaban | hoy |
|---|---:|---|
| 2021-08 | 126 (el mes completo) | completo |
| 2022-01 | 289 | completo |
| 2022-02 | 386 | completo |
| 2022-03 | 558 | completo |
| 2022-05 | 409 | completo |
| 2022-06 | 504 | completo |
| 2023-08 | 1,086 | completo |
| 2024-02 | 344 | completo |
| 2025-04 | 1,206 (todo del 16 al 30) | completo |

Y 2017-11 → 2021-08 entró desde Syntage (~10,600 CFDIs) — el único tramo que el
SAT no da nunca.

---

## Lo que NO se puede recuperar (no volver a intentarlo)

| qué | cuánto | por qué |
|---|---:|---|
| Emitidas 2018-06, 2018-10, 2020-06 | 93 | fuera de la ventana de 5 años y Syntage nunca capturó su XML |
| Recibidas vigentes pre-2021-08 | 2,012 · $67.4M | igual |
| Recibidas **canceladas** | 3,916 | **no son un hueco**: la descarga masiva del SAT no entrega recibidas canceladas. Es el residuo parejo de 3-8% en TODOS los meses. Una recibida cancelada no es deducción ni crea inventario. **No importarlas.** |

**Syntage está agotado como fuente.** Tiene los folios pero no los XML de
2022-2025 (`xml: false` → `GET /invoices/{id}/cfdi` da **404**). Comprobado
descargando: de 32 XMLs que entrega, ya teníamos los 32. Los PDFs **no traen el
NIV** — traen `No Motor:`, que sí sirve como llave (580 de 653 unidades del piso
tienen `numeroMotor`).

---

## La llave que destrabó todo: `tramos`

La cuota 5002 del SAT es **vitalicia y por (RFC + rango + tipo)**. Un mes
quemado se reabre pidiéndolo en **rangos distintos**:

```
sat-repesca?companyId=…&periodos=2025-04&tramos=2                 # dos quincenas
sat-repesca?companyId=…&periodos=2025-04&tramos=4&saltarTramos=2  # apunta al tramo 3
```

Tres cosas aprendidas peleándose con esto:

- **`importadas: 0` no es fallo.** Puede ser que ese rango ya esté completo, o
  que el paquete siga preparándose (`IN_PROGRESS` en `SatSyncRequest`). El SAT
  tarda **minutos u horas**; correr rondas con 4 min de pausa, no seguidas.
- **`saltarTramos` es obligatorio para el segundo tramo.** Re-verificar el
  tramo 1 vuelve a bajar su paquete y se come el presupuesto de 300s, así que
  el tramo 2 queda `pendiente` para siempre.
- **La cuota se gasta fuera de nuestro sistema.** `SatSyncRequest` registra lo
  que pedimos *nosotros*; el SAT cuenta lo que pidió *cualquiera* con esa FIEL
  (Syntage la tiene). Hubo meses sin ninguna fila nuestra que ya venían con
  5002. **Nunca inferir «cuota intacta» de nuestra tabla — preguntar.**

---

## Las cinco trampas que costaron horas

1. **`satDijo` sumando todas las solicitudes FINISHED del mes** → doble conteo
   (`submitSatSync` crea fila por re-pedido).
2. **La fila del mes completo y sus tramos** cubren los mismos días → doble
   conteo otra vez.
3. **Buscar el VIN en `InvoiceItem.descripcion`.** Las ventas lo traen en el
   complemento `ventavehiculos:VentaVehiculos` del `rawXml`
   (`src/lib/automotriz/vin.ts:10-12`).
4. **Medir emitidas con `tipo IN ('INGRESO','PAGO')`.** `Invoice.tipo` es el
   tipo de comprobante, **no la dirección**: deja fuera las 16,837 de nómina y
   pinta ~10% de falso faltante en todos los meses. La dirección sólo está en
   el XML: `Emisor Rfc = 'AMA170817NK1'`.
5. **La peor: el `JOIN` contra `SatSyncRequest`.** Un mes que nunca se pidió no
   tiene fila, así que desaparece de los DOS lados de la comparación y se lee
   como mes inexistente. Dio «100% de cobertura» y sirvió para declarar por
   escrito que no había hueco. Había nueve meses. **Para medir lo que falta, el
   eje de períodos lo genera uno (`generate_series`), NO la tabla auditada.**

Bonus, al leer la balanza: **el XML trae el mayor Y sus subcuentas**
(`1301-0000-0000` junto a `1301-0004-0000`). Sumar ambos duplica todo — dio
$1.9 mil millones. Sólo mayores, o sólo hojas. Ver `padresDeBalanza`.

Y: **la balanza más reciente es 2026-06, no 2026-07.** El importador la postea
como asiento de APERTURA del mes siguiente, así que en `AccountingEntry` aparece
con `month=7`. Comparar el piso al **2026-06-30**, no al 31 de julio (esa
diferencia sola valía $24M en unidades compradas en julio).

---

## El objetivo: la balanza presentada

42 balanzas presentadas y aceptadas (2023-01 → 2026-06) + 27 catálogos
(2023-01 → 2025-03), todas en Syntage (`electronic-accounting-records`).

**El plan de cuentas cambió en 2024-10.** Antes se presentaba con el **código
agrupador del SAT** (inventario = `115`); desde entonces con la numeración
propia (`1301-0000-0000`). Cualquier serie histórica tiene que manejar las dos.

Serie mensual de inventario en libros (extraída de las balanzas):

- 2023-01 → 2024-09: banda sana de **$57M a $129M**.
- **2024-12: $966,947,239** — un salto de **+$867M en un mes**.
- Luego baja ~**$148M mensuales** seis meses seguidos hasta 2025-06.
- 2025-07 en adelante: normal otra vez ($147M–$197M).

Una agencia con ~$100M de piso no compró $867M en un mes, y seis decrementos
casi idénticos son la firma de un asiento que se amortiza, no de autos que se
venden. Cae justo en el cambio de plan de cuentas. **Pregunta concreta para el
contador: ¿qué se posteó a inventario en diciembre 2024 y qué lo desarmó
mensualmente hasta junio 2025?** Hasta que eso se explique, los $147.5M no son
terreno firme.

---

## Los $33.2M que quedan (448 unidades al 2026-06-30)

Ya no es un problema de datos. Pistas concretas, en orden de tamaño:

1. **Unidades `POR REVISAR`** — medido bien el 2026-08-16, era más grande de lo
   que decía aquí: 26 u / $5.8M sin modelo en el piso al corte, 72 u más sólo
   sin marca, y los 3 autobuses Yutong ($27.9M, comprados 2026-07, post-corte)
   con la ClaveProdServ como modelo. Ver «Reparación del derivador» abajo.
2. **JAC6 y JAC8 salen NEGATIVOS** (~$3.4M): los libros cargan **más**
   inventario que el padrón. Eso apunta a **compras faltantes**, no a ventas —
   es la reparación contraria.
3. **16 cuentas del catálogo sin nombre** (`nombre = cuentaSAT`). Rompen
   cualquier conciliación por familia: mandan dinero bien contabilizado al
   bucket «sin explicar». Resuelto a medias el 2026-08-16 — ver la sección
   siguiente: 4 confirmadas (familia 28 = TRAVELER, cuadrada al centavo), y
   las otras 12 **no están en ningún CT presentado** — sólo el contador las
   tiene.
4. **Diferencias estructurales que NO van a cerrar al centavo**: el padrón
   guarda `costoCompra` (subtotal del CFDI) y los libros capitalizan flete,
   ISAN y preparación (para eso existe `VehiculoCosto`); la cuenta de inventario
   incluye refacciones y motos; y los seminuevos comprados a persona física
   pueden no tener CFDI. **El objetivo realista no es cero, es explicar cada
   bloque hasta que el contador esté de acuerdo.**

---

## Las 16 cuentas sin nombre: lo que se averiguó (2026-08-16)

Se descargaron los seis CT de numeración nueva (2024-10 → 2025-03) desde
Syntage. **Ninguno de los 16 códigos aparece en ningún CT presentado** — la
versión anterior de este documento decía que ahí estaban los nombres, y es
falso. Dos razones, ambas del contador:

- **Dejó de presentar el catálogo después de 2025-03.** Las balanzas siguen
  hasta 2026-06; los CT no. No es hueco de extracción: la extracción
  `electronic_accounting` del 2026-08-08 cubrió 2015 → 2026-08 y terminó
  `finished`. **No re-disparar: no hay nada más que traer.**
- **Los CT que sí presentó omiten cuentas EN USO.** `9200-0007`, `6602-0001`,
  `6700-2002` y `6600-2004` traían saldo en la balanza 2025-03 y no están en el
  CT de 2025-03. El catálogo presentado nunca estuvo completo (Anexo 24 obliga
  a re-presentarlo cuando se modifica).

**Confirmado con evidencia — familia 28 = TRAVELER.** Ventas TRAVELER 2025 en
el padrón: $6,049,258.62 = acumulado de `4101-0028` en la balanza 2025-12, al
centavo. Primera compra 2025-06-30, justo cuando la familia aparece en las
balanzas. Piso al corte: 10 u / $6.81M vs $6.98M en libros (flete/prep
capitalizados). Los nombres siguen la plantilla del propio CT
(`INVENTARIO VEHICULOS NUEVOS X` / `VENTA NUEVOS X` / `COSTO NUEVOS X` /
`DESCUENTO NUEVOS X`); `4201-0028` es contra-ingreso y el stub la tenía con
naturaleza A — se corrige a D. **La reparación está en
`scripts/nombrar-stubs-margom.ts`** (idempotente, `DRY_RUN=1` para previsualizar;
lógica y evidencia en `src/lib/contabilidad/nombrar-stubs.ts`).

**Las otras 12 sólo las tiene el contador**, pero su POSICIÓN en la plantilla ya
está decodificada — llevar esto a la conversación:

- Los cinco mayores de gasto (6100/6300/6400/6600/6700) comparten plantilla de
  subcuentas idéntica. Todos saltan de `2001 CUOTAS Y SUSCRIPCIONES` a
  `2005 AGUA`: **los códigos en uso `-2002/-2003/-2004` son exactamente los
  huecos** (servicios entre suscripciones y agua; `6700-2002` tiene saldo desde
  al menos 2025-03).
- `9200-0007` está entre `INTERESES PLAN PISO UNIDADES` (0006) y
  `EXCEDENTE PLAN PISO` (0008); las 0009–0012 son intereses por banco. $539,638
  en 2026-H1.
- `6602-0001` es hermana de `6602-0002 AMORTIZACIÓN DE SOFTWARE` — otra
  amortización, la única activa de su mayor en 2026.

---

## Reparación del derivador de generales (2026-08-16)

Las unidades `POR REVISAR` no eran un problema de datos: **la marca y el modelo
estaban escritos en la descripción de su propio CFDI** y la heurística no los
leía. Tres huecos, ya cerrados en `vin.ts` (con los machotes reales como tests):

- `GML` y `YUTONG` no estaban en la lista de marcas (70+ unidades «MARCA GML»).
- Un `NoIdentificacion` numérico (la ClaveProdServ: «25101502», «78181500»,
  «0001») entraba tal cual como modelo. Ahora se lee la descripción.
- Sin SKU (seminuevos de particulares) no había fallback: ahora
  `modeloDesdeTexto` recorre los machotes — `MODELO X` (no-año), el nombre
  después del año, `TIPO:` (si no es carrocería), `VERSION`, lo que sigue a la
  marca.

`scripts/reparar-generales-margom.ts` re-pasa las unidades rotas por el
derivador de producción (`generalesParaUnidad`, catálogo Anexo 15 primero — que
resuelve varios SKUs numéricos: «3661» → SUNRAY Pass 17 pasajeros). Dry-run
verificado contra prod: **443 reparables, 231 sin mejora posible** (su CFDI no
trae más; quedan para confirmación manual en la UI), 1 sin CFDI legible.
Se corre igual que nombrar-stubs, con `TS_NODE_BASEURL=. -r tsconfig-paths/register`.

Los 3 Yutong (298AR03) no están en el Anexo 15 ingerido (las claves de mitad de
año salen en las *modificaciones* del DOF): su modelo sale del texto
(«ZK6126BEVGS»). Cuando se publique la modificación 2026, re-correr
`automotriz:ingest-claves` los pone con dato autoritativo.

---

## Cómo conectarse

`claude_ro` **no sirve**: `DATABASE_URL_RO` trae un password que el servidor ya
no acepta. Mientras no se resincronice, entrar con la URL pública **forzando la
sesión a sólo lectura**:

```sh
PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=900000' \
  psql "$(railway variables --json | jq -r .DATABASE_PUBLIC_URL)"
```

No hace falta `railway connect` interactivo. `CRON_SECRET` y `SYNTAGE_API_KEY`
salen de `railway variables --service contabilidad-os --json`.

---

## Consultas que sirven

**Meses que nunca se le pidieron al SAT** — la que destapó todo. El eje lo
genera `generate_series`, no la tabla auditada. Cambiar `EMITIDOS` por
`RECIBIDOS` para el otro lado:

```sql
WITH meses AS (
  SELECT generate_series('2021-08-01'::date, date_trunc('month', now()), '1 month') AS m
),
req AS (
  SELECT year y, month mm, bool_or(status = 'FINISHED') AS ok
  FROM "SatSyncRequest"
  WHERE "companyId" = 'cmsjf1wna003kn70fb68bqhm4' AND tipo = 'EMITIDOS'
  GROUP BY 1,2
),
mias AS (
  SELECT date_trunc('month', fecha)::date m, COUNT(*) n
  FROM "Invoice"
  WHERE "companyId" = 'cmsjf1wna003kn70fb68bqhm4'
    AND "rawXml" ~* '<[a-z0-9-]*:?Emisor[^>]*Rfc="AMA170817NK1"'   -- dirección: trampa 4
  GROUP BY 1
)
SELECT to_char(meses.m,'YYYY-MM') mes, COALESCE(i.n,0) AS tenemos
FROM meses
LEFT JOIN req r ON r.y = EXTRACT(YEAR FROM meses.m) AND r.mm = EXTRACT(MONTH FROM meses.m)
LEFT JOIN mias i ON i.m = meses.m
WHERE r.ok IS DISTINCT FROM true
ORDER BY 1;
```

**Piso contra libros, en la fecha correcta:**

```sql
SELECT COUNT(*) unidades, SUM(v."costoCompra")::numeric(14,2) padron
FROM "Vehiculo" v
WHERE v."companyId" = 'cmsjf1wna003kn70fb68bqhm4'
  AND COALESCE(v."fechaCompra", v."createdAt")::date <= '2026-06-30'
  AND (v."fechaVenta" IS NULL OR v."fechaVenta"::date > '2026-06-30');
```

**Inventario en libros** (mayores, sin duplicar subcuentas):

```sql
SELECT SUM(CASE WHEN ae.tipo='CARGO' THEN ae.monto ELSE -ae.monto END)::numeric(16,2)
FROM "AccountingEntry" ae JOIN "ChartAccount" ca ON ca.id = ae."chartAccountId"
WHERE ae."companyId" = 'cmsjf1wna003kn70fb68bqhm4'
  AND ca."cuentaSAT" IN ('1301-0000-0000','1302-0000-0000','1312-0000-0000');
```

**Rendimiento:** extraer todos los NIVs de los 492 MB de `rawXml` de INGRESO con
`regexp_matches` corre en **~13 s**. No hace falta bajar XMLs ni escribir un
script: extraer del lado del servidor y sacar con `\copy … TO 'x.csv' CSV HEADER`
para cruzar en local sin volver a escanear.

---

## Auditoría externa: el censo de Syntage

El listado de Syntage (`/entities/{id}/invoices`, gratis) es el **único testigo
del archivo independiente del SAT**, y es lo que permitió medir la cobertura de
verdad. Trae `uuid`, `status`, `total`, `isIssuer`, `xml`, `pdf` e `items` con
`productIdentification` — pero **no trae complementos**, así que el NIV no se
puede sacar de ahí.

Caveats del endpoint, cada uno costó un PR:
- Sólo acepta paginación por **cursor** (`id[lt]` + header
  `X-Pagination-Style: cursor`), **sin** `order[...]`. `page` devuelve 400.
- `itemsPerPage` topa en **100**.
- Un CFDI cancelado pierde el XML pero **no el renglón**: el `status` sigue
  viniendo.

---

## Restricciones vigentes

- **No abrir la red ni crear un endpoint SQL genérico.** La base tiene facturas,
  clientes y nómina de personas reales.
- **Pendiente del usuario:** rotar `CRON_SECRET`, el password de Postgres y el
  de `claude_ro`, y volver a poner el nuevo en `DATABASE_URL_RO`.
- Las reparaciones se envían **como código, en PRs con pruebas**. Desde la
  terminal se lee y se diagnostica.

---

## Lo que sigue

1. **Correr `scripts/nombrar-stubs-margom.ts`** (familia 28 = TRAVELER; con
   `DRY_RUN=1` primero). Con eso, 4 de las 16 cuentas quedan con nombre y el
   bloque de $6.98M de inventario se concilia por familia.
2. **Dos preguntas para el contador**, ya con evidencia lista:
   - **Diciembre 2024**: +$867M a inventario y su desarme en seis mensualidades.
   - **El catálogo vigente de su ERP** (export de CONTPAQ o equivalente): las
     12 cuentas restantes no están en ningún CT presentado, y de paso el CT no
     se re-presenta desde 2025-03 aunque hubo altas (Anexo 24).
3. **Las 23 unidades `POR REVISAR`** y las familias JAC6/JAC8 en negativo.
4. **Alarma para que esto no vuelva a pasar en silencio.** El hueco vivió años
   porque nada compara la serie de meses contra un censo externo. La consulta de
   `generate_series` de arriba es un cron de tres líneas: cualquier mes de la
   ventana sin solicitud FINISHED —o con <20% de las emitidas de sus vecinos—
   debería gritar.
5. Plan CE-first (`docs/` + tareas #16/#13/#10): los estados financieros deben
   leer la balanza presentada, no el motor de posteo.
