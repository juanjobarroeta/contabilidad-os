# Plan: el motor de posteo sobre el plan de cuentas de la empresa

**Meta**: UN solo estado financiero. El motor deriva sobre las MISMAS cuentas
que el contador declara, la diferencia mensual contra la balanza presentada
(`CeBalanzaMes`) se vuelve una lista de ajustes con nombre, y cuando esa lista
la captura el contador en el sistema (fuente MANUAL, que `postMonth` ya
preserva), derivado + capturado = declarado. Ahí los dos estados son uno, y el
paso final es GENERAR la CE desde aquí en vez de espejearla.

No se vende «nuestros números en vez de los tuyos»: se vende «día uno espejamos
lo declarado; luego te demostramos cuánto lo re-derivamos de documentos, y te
enseñamos las diferencias que no sabías que tenías». El contador pasa de
capturista a revisor. La conciliación de inventario ($272M → $28.7M explicados)
es el precedente del método.

Por qué es factible sin cirugía: `postMonth` es IDEMPOTENTE (borra y regenera
CFDI/NOMINA/BANCO/DEPRECIACION por período y preserva lo manual). Cambiada la
resolución de cuentas, re-postear la historia ES la migración.

## Fase 0 — persistir `CodAgrup` (hecha)

El CT de la empresa declara el agrupador de cada cuenta propia
(4101-0027 → «401.01»); el import lo parseaba y lo tiraba. Ahora
`ChartAccount.codAgrup` lo guarda (create y update; un CT sin él no borra la
llave). Se rellena solo con el siguiente harvest del sync (importarCatalogo).

## Fase 1 — resolución al plan propio, con fallback

`resolverCuentaEmpresa(companyId, codigoMotor)`: invertir codAgrup → cuenta(s)
propia(s). Sin ambigüedad → esa cuenta. Con varias candidatas (los agrupadores
de gasto existen por DEPARTAMENTO: 6100/6300/6400/6600/6700 comparten
plantilla) → tabla chica de overrides por empresa (se siembra sola con las no
ambiguas; las ambiguas las decide el contador UNA vez). Sin mapeo → fallback al
stub agrupador de hoy (adopción gradual, cero big-bang). Shim en el único punto
de resolución del motor; re-posteo de la historia al activarlo.

### Cobertura medida (MARGOM, 2026-08-16)

38 códigos usa el motor. **16 resuelven ÚNICOS ya** — entre ellos IVA
acreditable 118.01 ($772M posteados) y toda la familia de activo fijo 171.xx —
y se flipan al plan propio con el siguiente re-posteo.

**Los cuatro gigantes, resueltos con evidencia (2026-08-16).** Medido contra
CeBalanzaMes (flujos 2024-10 → 2026-06) antes de decidir:

| gigante | motor empuja | veredicto |
|---|---|---|
| 201.01 proveedores | $3.71B abonos | **override → 2002-0001 CXP PLANTA VEHICULOS** (~$4.07B/lado en CE, 91% de coincidencia; la otra grande, CXP FINANCIERA, es plan piso — flujo bancario, no CFDIs). Aplicado con `scripts/override-proveedores-margom.ts`. |
| 105.01 clientes | $4.75B cargos | **ningún override es honesto**: la CE lo reparte en tres (FI ~$1.95B, UNIDADES NUEVAS ~$1.66B, INTERCAMBIOS ~$0.95B) sin dominante. Va por resolución de MÓDULO: la venta de unidad ya sabe su CXC (1206-0001), refacciones → 1217, servicio → 1214. |
| 401.01 ventas | — | resuelto por FAMILIA (Fase 2); el resto genérico es refacciones/servicio/TOT → misma resolución de módulo. |
| 601.84 otros gastos | $456M (era $4.8B antes de que las unidades se fueran a 1301) | sin contraparte dominante en la CE (48 candidatas, la mayor $5M): refinamiento del clasificador + export del contador, no override. | **Sin candidata** (el CT no declara ese
agrupador): 701.10 ($39.6M), 601.32 ($9.9M), 601.50 ($0.7M) — se quedan en
stub hasta el export del contador.

## Fase 2 — resolución por módulo (AUTOMOTRIZ) (hecha)

La venta/costo/inventario de una unidad resuelve por su FAMILIA a la subcuenta
exacta (4101-00XX / 5101-00XX / 1301-00XX). Aquí el derivado por familia se
vuelve comparable renglón a renglón contra la CE — la conciliación de
inventario, pero automática y mensual.

Implementada (2026-08-16):

- **El mapa modelo→familia es módulo canónico**
  (`src/lib/contabilidad/familia-vehiculo.ts`); el script de divergencia
  importa de ahí. Los patrones quedan en dialecto Postgres (`\m`/`\M`) y
  `regexJs()` los traduce — un solo origen para SQL y JS.
- **`resolver-familia.ts`**: índice (codAgrup:sufijo) → cuenta propia, con la
  misma filosofía de Fase 1 — sufijo duplicado bajo un agrupador = ambiguo =
  fallback. Empresa sin CT o sin numeración por familia → índice vacío → CERO
  cambio de conducta.
- **En `postMonth` (y sus dos previews, mismas reglas)**: un CFDI que ampara
  una unidad NUEVA de venta postea la venta en 4101-00XX y su costo como
  DR 5101-00XX / CR 1301-00XX (sólo si las TRES cuentas de la familia
  resuelven); la compra de unidad carga a 1301-00XX en vez de gasto por
  clasificador. `overrideCuenta` e INVERSION mandan sobre la familia. Un CFDI
  multi-unidad sólo resuelve si TODAS sus unidades son de una misma familia.
- **El costo derivado es `costoCompra`**, no incluye los costos capitalizados
  (`VehiculoCosto`): esos CFDIs hoy postean como gasto y moverlos a inventario
  es fase posterior. La divergencia mensual contra CE lista ese delta.
- Falta para verla en números: **re-posteo histórico** (postMonth idempotente,
  por período — lo corre el usuario) y comparar la serie 1301/4101/5101
  derivada contra `CeBalanzaMes`.

## Fase 2c — el comprobante de EGRESO es un espejo, no una venta

**Hallazgo del 2026-08-18** (medido al ir a comparar taller contra CE). El
motor seleccionaba `tipo: INGRESO, status: STAMPED` sin mirar nunca `tipoSat`:
toda nota de crédito emitida posteaba como venta. Una nota de $19.8M quedaba
CARGO clientes $19.8M / ABONO ventas $17.1M / ABONO IVA causado $2.7M — el
asiento de una venta, con el signo al revés.

Lo que lo vuelve grave no es el signo sino el **anticipo**: 10,024 de las
15,660 notas emitidas en la ventana de la CE traen TipoRelacion **07,
aplicación de anticipo** ($531.2M de $628.3M). En el procedimiento del SAT el
anticipo se factura completo, la operación total se factura completa otra vez,
y la nota de egreso resta el anticipo. Es la nota —no la factura— la que evita
el doble conteo. Al posteala como ingreso, **cada anticipo quedaba contado dos
veces**, con su IVA causado y su cargo a clientes (parte del saldo de CxC
derivado que no baja nunca).

Tamaño, ventana 2023-01…2026-06 de la CE:

| concepto | asientos | importe | efecto al corregir |
|---|---:|---:|---:|
| Notas emitidas (E, INGRESO) a ingresos | 13,448 | $628.3M abonados | vuelco de $1,256.5M |
| Notas recibidas (E, EGRESO) a gasto | 975 | $59.3M cargados | vuelco de $118.7M |
| Divergencia total del grupo 4 vs CE | | **$1,288.5M** | queda ~$32M |

`nota-credito.ts` centraliza la regla (`esComprobanteDeEgreso`, `espejo`,
`signoDeComprobante`) y los tres consumidores la aplican igual: `postMonth`,
`balanzaPreview` y `estadoResultadosPreview`. El costo de venta NO se revierte
en la nota: saber si la unidad volvió al piso lo dice el inventario, no el CFDI.

Verificado sin escribir (`scripts/dry-notas-credito-margom.ts`, grupo 4 del mes):

| período | CE declarado | ledger de hoy | motor con espejo | hoy vs CE | espejo vs CE |
|---|---:|---:|---:|---:|---:|
| 2024-06 | $59.4M | $53.9M | $54.3M | −$5.50M | −$5.04M |
| 2025-03 | $242.7M | $277.0M | $241.7M | +$34.28M | −$0.97M |
| 2025-06 | $170.1M | $213.1M | $171.6M | +$43.02M | +$1.48M |
| 2026-03 | $97.0M | $160.3M | $97.7M | +$63.32M | **+$0.66M** |
| 2026-06 | $116.5M | $180.8M | $123.6M | +$64.31M | +$7.15M |

**Re-posteado el 2026-08-19**: 61 períodos (2021-08 → 2026-08), 0 saltados,
0 errores. Verificado con `scripts/verificar-divergencia-margom.ts` sobre la
ventana de la CE:

| corte | antes | después |
|---|---:|---:|
| Grupo 4 (ingresos) derivado vs CE | +$1,288.5M | **+$45.2M** |
| Grupo 5 (costos) derivado vs CE | +$1,379.6M | +$623.5M |
| Grupo 6 (gastos) derivado vs CE | −$1,517.7M | −$619.6M |
| Ingreso posteado de CFDIs CANCELADOS | $157M | **$0** |

Los grupos 5 y 6 mejoraron sin tocarlos: entre el re-posteo anterior (2026-08-07)
y éste se ligaron más unidades a su venta, así que más CFDIs resuelven familia —
más costo sale de 1301 y más compra entra a inventario en vez de gasto.

## Fase 2d — taller: el motor no conoce ni servicio ni refacciones

Misma medición. La CE declara mano de obra y refacciones en sus propias
cuentas; lo derivado tiene **cero** en todas ellas y lo manda al fallback 401:

| cuenta | CE 2023-01…2026-06 | derivado |
|---|---:|---:|
| 4301 venta mano de obra (servicio, H y P, garantías) | $37.95M | $0 |
| 4401 venta refacciones y accesorios | $95.69M | $0 |
| 5301 costo mano de obra | −$8.20M | $0 |
| 5401 costo refacciones | −$62.83M | $0 |

**Resuelto para el ingreso** (`taller.ts`). Dos decisiones, las dos leídas de
los datos del contador:

- **Qué cuenta**: la serie no basta —4401 tiene seis subcuentas activas—, así
  que desempata el NOMBRE del catálogo del propio contador, como lo haría él:
  «VENTA REFACCIONES TALLER» para lo que sale de una orden, «VENTA REFACCIONES»
  para el mostrador. Sin candidata única → null y el asiento cae al fallback:
  adivinar subcuenta es peor que no resolver.
- **Cómo se parte**: una orden factura mano de obra Y refacciones en el mismo
  CFDI. `ServicioVenta` ya guarda ese corte, y se usa como PROPORCIÓN escalada
  al subtotal, así las piernas suman el subtotal exacto aunque el corte del DMS
  venga incompleto (cuadra al centavo en 16,452 de 24,042 órdenes, 80% del
  importe).

Dry-run contra la CE (`scripts/dry-taller-margom.ts`, neto del mes):

| cuenta | 2025-06 CE | 2025-06 derivado | 2026-03 CE | 2026-03 derivado |
|---|---:|---:|---:|---:|
| 4401-0009 refacciones taller | $4,390,160 | $4,137,568 | $3,119,193 | $4,334,806 |
| 4401-0001 refacciones mostrador | $866,300 | $283,077 | $1,039,569 | $506,520 |
| 4301-0001 mano de obra servicio | $1,190,887 | $1,698,308 | $1,492,027 | $2,485,695 |
| **serie 4301 completa** | **$1,945,505** | $1,698,308 | **$2,470,068** | **$2,485,695** |

Ya en el ledger (re-posteo del 2026-08-19), comparado por año — la CE de 2023 y
casi toda la de 2024 **no usa estas series** (es la era agrupador previa a
2024-10, ver Riesgos), así que el tramo comparable arranca en 2025:

| año | 4301 CE | 4301 derivado | 4401 CE | 4401 derivado |
|---|---:|---:|---:|---:|
| 2023 | $0 | $20.64M | $0 | $0.95M |
| 2024 | $2.89M | $28.28M | $9.25M | $7.06M |
| **2025** | **$20.98M** | **$20.54M** | $52.66M | $46.20M |
| **2026 H1** | **$14.08M** | **$14.55M** | $33.79M | $29.01M |

Mano de obra cae dentro del 2–3% en el tramo comparable; refacciones al 86–88%.
El sobrante de 2023-2024 en 4301 es la regla «orden sin corte del DMS → toda a
mano de obra» aplicada a años cuyo DMS no traía el corte: ahí no hay contra qué
comparar, pero conviene revisarla cuando se ataquen las garantías.

Lo que falta para cerrar el resto (queda nombrado, no perdido):
- **Garantías** (4401-0013, 4301-0003: $17.4M en la ventana) — el destino
  depende de reconocer a la PLANTA como contraparte del CFDI.
- **Hojalatería y pintura** (4301-0002/0005: $7.95M) — hoy cae en mano de obra
  de servicio; el corte necesita una señal que el CFDI no trae.
- **El costo del taller** (5301/5401, $71M declarados) — necesita costeo de
  inventario de refacciones: `Refaccion.ultimoCosto` es el último costo, no el
  del día de la venta.

Nota operativa: **`OrdenServicio` está vacío** (0 renglones) — el taller no se
opera en ContabilidadOS. Lo que existe son 29,382 `ServicioVenta` derivadas de
CFDIs (2018-11 → 2026-08, todas con factura) y 151,853 `RefaccionMovimiento`.

## Fase 2f — la refacción comprada es costo, no gasto

**2026-08-19.** El taller ya vendía en sus cuentas (2d) pero su costo seguía
cayendo en el mayor genérico de gastos. La CE declara $35.1M en 5401 sólo en
2025; lo derivado tenía cero.

**Por qué el costo entra por la COMPRA y no por la venta.** El movimiento de
salida del DMS trae el PRECIO, no el costo: vale exactamente el subtotal del
CFDI que lo ampara —ratio 1.000 en 1,236 facturas de mostrador de 2025— así que
usarlo como costo daría margen cero. Y el costo unitario del catálogo no sirve:
valuar las salidas de 2025 con `Refaccion.ultimoCosto` da **$1,138M** contra
$36.6M de venta, 31× fuera; el promedio ponderado por refacción a partir de las
entradas da **$1,056M**, igual de inservible (las cantidades de entrada y salida
no comparten convención).

Sin costo unitario confiable no hay costeo perpetuo, así que el reconocimiento
es **analítico**: la compra del período es el costo del período. Es válido
mientras el inventario sea estable, y aquí lo es — la CE mueve $5.8M netos en
1314 sobre 42 meses contra compras de $37.6M en un solo año. Contraste 2025:
compras de refacción $37.6M contra $35.1M declarados en 5401, **7% de
distancia**. Se carga sólo la parte del CFDI que entró al almacén; el resto del
comprobante (fletes, otros conceptos) sigue su clasificación. El destino
—taller o mostrador— no lo sabe la factura del proveedor, así que se reparte con
la mezcla de venta derivada del propio período.

## Lo que falta, con nombre y tamaño (medido sobre 2025)

| hueco | tamaño | ¿derivable sin bancos? |
|---|---:|---|
| Tipo de venta de unidad: 5131 intercambio, 5141 flotilla, 5291 usados — todo cae hoy en 5101 | $757.7M | **Sí**: la SERIE del CFDI lo dice (NV\*, UN\*, SM\*). Falta el mapa serie→cuenta por empresa |
| Gasto al catálogo propio: $392.9M en el mayor 601 contra $170.5M repartidos en sus 6xxx | ~$222M | Parcial: el concepto se deriva, el DEPARTAMENTO no lo dice el CFDI (8 copias por concepto) |
| Garantías de taller (4401-0013, 4301-0003) | $17.4M/ventana | Sí, si se reconoce a la planta como contraparte |
| Hojalatería y pintura (4301-0002/0005) | $7.95M/ventana | No hay señal en el CFDI |
| CxC / CxP / IVA en flujo | ~$9,600M de saldo | **No**: necesita movimientos bancarios |

## Fase 2g — el intercambio es la unidad que se vende al costo

**2026-08-20.** El contador tiene una serie completa por familia para
intercambio (4131 venta, 5131 costo, 27 subcuentas cada una) y el motor no la
usaba nunca: todo caía en 4101/5101. $735.5M declarados en 4131 entre 2023-01 y
2026-06 — el 35% de la venta de unidades de 2025.

**Qué es, en realidad.** No es la permuta con un cliente. La balanza lo dice
sola: mes con mes el abono de 4131 y el cargo de 5131 son el MISMO importe —
$158,954,544 contra $158,954,535 en marzo de 2025, nueve pesos sobre ciento
cincuenta y nueve millones. Es el intercambio entre distribuidores, que se mueve
a costo: el otro concesionario tiene la unidad que tu cliente quiere y se la
cambias por una tuya, sin margen para ninguno.

Por eso la señal es el **margen**, no el catálogo ni la serie del folio: una
venta de unidad cuyo precio iguala su costo es un intercambio. Tolerancia
±0.2%; aflojarla a ±2% apenas mueve la aguja ($766.6M contra $754.3M), señal de
que el grupo está pegado al cero y no repartido en una curva.

Contraste con la CE corriendo `balanzaPreview` de esta rama:

| período | 4131 CE | 4131 derivado | 4101 CE | 4101 derivado |
|---|---:|---:|---:|---:|
| 2025-02 | $161,955,167 | $155,113,004 | $65,269,090 | $70,611,465 |
| 2025-06 | $66,647,366 | $64,273,315 | $92,019,460 | $96,079,732 |
| 2026-06 | $15,132,067 | $14,823,496 | $82,020,667 | $89,695,951 |

96–98% de lo declarado, y 5131 derivado sale idéntico a 4131 derivado al peso,
que es la definición misma de una venta al costo.

### Lo que se midió y NO se dedujo

- **Flotilla (4141)**: la CE declara $4.1M en todo 2025. La regla natural —tres
  o más unidades del mismo modelo, mismo cliente, mismo mes— atrapa $1,272.6M.
  Sobra por trescientos a uno: aquí vender varias unidades iguales al mismo
  cliente es lo normal, no una flotilla. Sin señal, no se clasifica.
- **Seminuevos (4291/5291)**: la venta se identifica (serie SM\*, $44.7M contra
  $44.5M declarados en 2025 — 99.6%), pero el contador la parte en AFECTOS y NO
  AFECTOS y esa distinción no está en el CFDI: el IVA trasladado da la
  proporción al revés ($36.1M con IVA contra $12.8M declarados como afectos).
  **Pregunta de una línea para el contador**, y quedan dos cuentas resueltas.
- **2025 H1 concentra el intercambio** ($692.4M de los $713.3M del año) y luego
  cae al 3%. No es un artefacto contable: es un semestre en que el piso se
  desbalanceó. Vale la pena preguntarlo, pero el motor ya lo sigue mes a mes.

## Fase 2h — la serie del folio como decisión del contador

**2026-08-20.** Queda un ingreso que ningún documento clasifica solo: el
**back-end** de la agencia —comisión por colocar el financiamiento, GAP y UDIS,
garantía extendida, incentivos de la planta—. Sale por CFDIs que no amparan
unidad ni orden de taller, y el concepto no alcanza: la misma clave de producto
sirve para un anticipo y para una comisión. La CE lo declara en 4501 y lo
derivado tenía **cero** ($70.1M en la ventana, $35.2M sólo en 2025).

Lo que sí lo dice es la **serie del folio**, porque el DMS la usa para separar
justo eso. Medido sobre 2025:

| serie | qué es | derivado | declarado | |
|---|---|---:|---:|---:|
| `NCA*` | notas de cargo → 4501 | $35,583,312 | $35,249,323 | **100.9%** |
| `SM*` | seminuevos → 4291 | $44,970,659 | $44,547,901 | **100.9%** |

Pero una serie es convención de CADA empresa, no regla del SAT: «NCA» no
significa nada fuera de este DMS. Por eso no vive en el código sino como
DECISIÓN, en la misma tabla de overrides del contador con el prefijo `serie:`
(`serie:NCA` → 4501-0008). Una empresa sin reglas se comporta exactamente como
hoy. Gana el prefijo más largo, así que refinar por sucursal —`serie:NCAZ` a
comisión de apertura mientras `serie:NCA` queda en diversos— no necesita código,
sólo otra decisión.

La regla se aplica SÓLO donde el motor ya se rindió: después de la unidad
(familia) y del taller. Una decisión mal escrita no puede desviar una venta que
hoy resuelve bien; a lo más, llena el fallback.

Queda anotado lo que la regla NO resuelve: el reparto DENTRO de la serie. Todo
`NCA*` cae hoy en ING DIVERSOS aunque el contador lo abra en comisión de
apertura, UDIS y garantías extendidas; todo `SM*` en USADOS AFECTOS aunque él
separe afectos de no afectos. El total del rubro sí cuadra, y el corte fino es
una decisión suya —el mecanismo ya la admite.

## Fase 3 — rubros exactos, cada uno con su checksum CE

En orden de tractabilidad (datos completos de nuestro lado):
1. **CxC / CxP**: CFDIs + REPs dan el aging derivado completo; checksum contra
   105/2xxx de la balanza.
2. **IVA**: el motor cash-basis contra el IVA DECLARADO (Syntage tiene las
   declaraciones mensuales).
3. **Depreciación / activo fijo**: el motor ya postea DEPRECIACION y existe el
   ajuste INPC; alinear vidas/tasas contra la depreciación declarada por cuenta.
Cada rubro estrena su panel de divergencia mensual (el patrón del inventario).

## Fase 4 — el cierre con residuo

Panel de cierre: derivado vs declarado por cuenta; el residuo se captura como
asientos MANUAL del contador (ya preservados). Residuo = $0 sostenido →
**un solo estado de resultados**, y la CE se genera desde el sistema.

## Riesgos conocidos

- El CT presentado está incompleto (12 cuentas en uso sin catálogo — pedido el
  export del ERP del contador): la inversión necesita ese export para cubrirlas.
- Los ~$1.4B de traspasos internos (divergencia-ce): el motor no los deriva y
  no debe — viven en el residuo del contador o se modelan como reglas después.
- Era agrupador (pre-2024-10): la historia vieja se queda en agrupador; la
  resolución al plan propio aplica desde donde el CT propio existe.
