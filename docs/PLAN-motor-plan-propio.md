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
