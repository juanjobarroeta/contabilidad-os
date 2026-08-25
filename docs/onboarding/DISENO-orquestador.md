# Diseño del orquestador de onboarding

Qué construir para que dar de alta una distribuidora nueva —lo que en MARGOM
tomó semanas— sea un asistente de minutos: el sistema hace todo lo que puede
solo, y un agente Claude razona las decisiones que quedan. Este documento cierra
la fase de diseño; no hay código todavía.

## Principio rector: nada es destructivo

`postMonth` es idempotente. Cada decisión contable —override, regla de serie,
familia— se aplica re-posteando, y una decisión equivocada se deshace cambiándola
y volviendo a postear. **Eso es lo que hace segura la automatización agresiva**:
el sistema puede aplicar solo lo que tiene alta confianza, porque revertir es
barato. Ningún paso borra, sólo regenera.

## Dos mitades

### Mitad A — Derivación (YA EXISTE, corre por crons)

`onboarding-estado` ya rastrea 6 etapas automáticas — «todo pasa solo»:

1. Descarga de XML (CFDIs)
2. Verificación de cancelaciones
3. Inventario de unidades (VIN + ClaveVehicular contra el catálogo Anexo 15)
4. Refacciones — catálogo + kardex
5. Servicio — historia del taller (mano de obra vs refacciones por concepto)
6. Clientes/proveedores (implícito, de la contraparte del CFDI)

Servicing, parts, clientes y proveedores NO son huecos: son estas etapas y ya
corren por alta.

**Falta una salida de derivación por cablear al alta:** `OrdenServicio` (la
orden de taller que ve la pantalla) está VACÍA aunque `ServicioVenta` esté llena
— derivamos la venta facturada del CFDI pero nunca creamos la orden.
`backfill-ordenes-servicio.ts` la reconstruye desde ServicioVenta +
RefaccionMovimiento (estado ENTREGADA, líneas de mano de obra y refacciones;
diagnóstico/técnico/kilometraje quedan null porque viven en el DMS, no en el
CFDI). En MARGOM: 29,482 órdenes / 117,982 líneas. **Va como etapa 7 de la Mitad
A una vez probado** — es derivación pura, idempotente, sin juicio. El catálogo de clave vehicular (global, ya poblado) es la base
limpia de toda la derivación.

### Mitad B — Cuadre (POR CONSTRUIR, etapas 7–12)

Lo que llevó a MARGOM de $1.6B de divergencia a 0.09% y NO está en el pipeline:

7. Importar el catálogo del contador (o partir de uno estándar de agencia)
8. Backfill de codAgrup + derivación de familias (`derivar-familias.ts`)
9. Overrides de agrupadores gigantes
10. Reglas de serie (back-end: 4501, seminuevos: 4291)
11. Importar la CE presentada (`CeBalanzaMes`) — la verdad
12. Re-postear + verificar divergencia

## Los tres niveles de automatización

Cada etapa de cuadre cae en un nivel según cuánto juicio pide:

**Nivel 1 — AUTO, silencioso.** Determinista, reversible, sin juicio. Corre sin
preguntar: codAgrup por unanimidad, familias que cazan unidades sin choque,
importar CE, re-postear, verificar.

**Nivel 2 — AUTO cuando la evidencia es abrumadora, aplicado y mostrado.** Es una
decisión, pero cuando una respuesta domina tanto que un humano la firmaría sin
pensar, el asistente la aplica y la MUESTRA con un deshacer:
- Override de agrupador: se aplica si un candidato concentra la evidencia por un
  margen amplio (en MARGOM, CXP PLANTA fue 91–100%).
- Regla de serie: se aplica si la serie mapea a una cuenta muy cerca de lo
  declarado en la CE (NCA→4501 y SM→4291 fueron 100.9%).

**Nivel 3 — SE PRESENTA para decidir.** Ambigüedad genuina: agrupador sin
candidato dominante (601.84 en MARGOM, $456M sin claro ganador), familias
marcadas, codAgrup huérfano, el catálogo mismo.

## El nivel 3 lo razona un agente Claude, no un menú

La decisión final NO es un botón estático: el onboarding **convoca a un agente
Claude** que razona sobre la misma evidencia que un humano usaría —las cuentas
candidatas, el dinero que mueve cada una, el delta contra la CE, los nombres del
catálogo del contador, el padrón— y o la resuelve, o le entrega al contador una
recomendación con su porqué. Es exactamente el razonamiento que se hizo a mano
para MARGOM, hecho por alta.

Por eso **los umbrales no se fijan en código**. En vez de una constante
(«≥90%»), el agente juzga cada caso, y el umbral real se MIDE a lo largo de las
altas: se observa qué margen resultó seguro auto-aplicar y cuál necesitó ojo
humano. La confianza se calibra con datos, no se adivina.

Lo que el orquestador le da al agente por cada decisión ambigua (el «paquete de
evidencia»): código del motor, cuentas candidatas con su codAgrup y nombre, el
dinero que cada una re-postearía, el saldo declarado en la CE de cada candidata,
y ejemplos de los CFDIs afectados. Con eso el agente razona como se razonó aquí.

## Quién supervisa: narración determinista, agente sólo cuando importa

Se resolvió no poner un agente a MANEJAR todo el onboarding —eso haría cada alta
un camino de ejecución distinto e irreproducible, inaceptable para libros—. En su
lugar, tres voces, y sólo dos cuestan:

- **Narración (gratis, determinista):** la que le da al alta el aire de un agente
  que te acompaña —«detecté tu FIEL, bajando CFDIs… 84,110 detectados, 39 marcas,
  1,247 clientes, poblando inventario…»— NO es un LLM: son los eventos de
  progreso que el pipeline YA registra (`onboarding-estado` lleva
  procesados/derivados por etapa), presentados en lenguaje humano. Reproducible,
  cero tokens.
- **Agente de decisión (LLM, raro):** se convoca en las compuertas de nivel 3
  para razonar sobre el paquete de evidencia.
- **Agente de sorpresa (LLM, raro):** cuando una etapa falla de un modo que el
  código no anticipó, se convoca para DIAGNOSTICAR y proponer —no para arreglar
  en silencio—, como se diagnosticó a mano el `error.seg.0001` o los 134 syncs
  colgados.

El código es dueño de la ejecución y el orden (determinismo donde se necesita
confianza); el agente, del juicio y las sorpresas (razonamiento donde se necesita
adaptación). Cuánto se convoca al agente se MIDE en las primeras altas: si el
camino feliz casi nunca es feliz, se le da más rol; si las sorpresas de MARGOM ya
quedaron en el código, con convocarlo en las compuertas basta.

## La cara: un asistente que hace todo y pregunta lo mínimo

```
Conectar FIEL
   ↓  (Mitad A + Niveles 1–2 corren solos, ~minutos)
"Setup 92% listo. Quedan 6 decisiones:"
   • Catálogo: ¿subes el tuyo o partimos de uno estándar?
   • 601.84 ($456M): el agente propone X porque… [aceptar] [otro]
   • Familia "TRACTO K7": ¿confirmas patrón K7?
   • serie NCA → ING DIVERSOS ✓ (97% — deshacer?)   ← nivel 2, pre-resuelto
   ↓  (el contador revisa/decide con el agente)
Re-postear + verificar → "Divergencia: 0.4% ✓"
```

Los de nivel 2 aparecen **pre-resueltos con deshacer** (se revisan, no se
deciden); los de nivel 3 traen la **recomendación razonada del agente**. El
contador termina resolviendo un puñado, no cincuenta.

## Estados de cuenta de clientes

`cartera` ya los produce: saldo, antigüedad (`masAntigua`), PPD cobrado sin REP,
con evidencia de pago REP-primero-banco-después. Se envían **REP-based desde el
alta** con banner «exacto al conectar bancos». No esperan a los bancos.

## El futuro con bancos: enriquecimiento, no reconstrucción

Cuando lleguen los estados de cuenta, la **autoconciliación que YA existe** en
ContabilidadOS (SPEI/transferencias/REC → aplica el pago al RFC de cliente o
proveedor) cierra el hueco de PPD-sin-REP sola. `cartera` pasa de REP-exacta a
caja-exacta sin reconstruir nada; sólo las facturas genuinamente ambiguas caen
en el escritorio del contador — trabajo chico. Es una **etapa posterior de
enriquecimiento**, fuera del alta inicial, que sigue siendo sólo-FIEL.

## Cross-check de CFDIs (parte del alta)

Antes de derivar, el alta prueba que el archivo está completo: lista de CFDIs
nuestra vs la fuente (Syntage hoy, portal SAT después), **incluyendo
cancelados**. Emitidas cancelledas las tenemos; recibidas canceladas son el
hueco conocido de descarga masiva (el proveedor las canceló, el WS no las
entrega) — se marca, no se esconde.

## Autocuración del sync SAT (requisito, hoy NO automatizado)

El conocimiento de cómo destrabar el sync está documentado
(`HANDOFF-inventario-cfdis.md`: tramos, cuota 5002 vitalicia, `saltarTramos`, las
cinco trampas de medición). Lo que NO está automatizado —y por eso cada alta
repetiría el firefighting manual— son tres guardas que el orquestador DEBE traer:

1. **Reaper de colgados**: una solicitud `IN_PROGRESS` que lleva >N horas se
   marca `FAILED` para que pueda reintentarse. Medido en MARGOM (2026-08-22):
   ~134 solicitudes colgadas desde el 7 de agosto, ninguna se cae sola.
2. **Reintento con tramos más cortos al fallar**: `FAILED` («Error no
   controlado» o bloqueo por cuota) debe re-disparar el rango partido en más
   tramos —`partirMes` ya existe en `sat-tramos.ts`—, no quedarse en FAILED
   esperando a un humano.
3. **Detector de huecos de cobertura**: el eje de períodos por `generate_series`
   (trampa #5) como GUARDA del sync, no como consulta manual — que el alta
   afirme «cobertura completa» sólo cuando de verdad lo es.

Sin estas tres, la cobertura de datos igual llega (los syncs completos
aterrizan), pero la maquinaria acumula colgados y fallidos en silencio. Para un
alta de minutos, el sync tiene que curarse solo.

## ISAN: se CALCULA al vender, no se extrae (Vehiculo.isan en $0)

`Vehiculo.isan` existe y su comentario lo dice —«calculado al vender unidades
NUEVO»— pero nunca se calcula: 0 en las unidades nuevas del padrón. No es un
parser: el ISAN NO viene en el CFDI (0 rastros en compra y venta), es un impuesto
que el distribuidor computa de una TARIFA.

**Pero SÍ se declara** — y aquí dos trampas de balanza mordieron a dos agentes,
vale documentarlas: el ISAN causado es el FLUJO (abonos) de 2402, no su SALDO, y
2402 tiene mayor + subcuentas (sumar ambos duplica). El causado real, sólo hojas:

  2402 causado (abonos)   2024 $7.87M · 2025 $37.64M · 2026 $11.68M

(el saldo se queda chico porque se entera cada mes — pasivo que rota). La primera
versión de este doc citó $494K: era el SALDO de un corte, no el causado. Y un
conteo padre+hija daba $23.35M en 2026: el doble del real.

Es una computación fiscal (como depreciación/INPC), no derivación. Un `calcularIsan()`
al vuelo sobre `precioVenta` da **$18.6M en 2026 — ~59% ARRIBA de los $11.68M
declarados**. Que SOBRE, no que falte, dice cuál es el trabajo de modelo, en orden:

1. **Exención por tipo de unidad** (baja el calc, DOMINANTE): el ISAN exenta
   comerciales de carga sobre cierto límite, y MARGOM vende justo eso (JAC carga,
   tractos K7). Aplicar tarifa plena a unidades exentas es lo que infla el calc.
2. **Base sin descuento** (sube el calc, secundario): Art. 2 — la base es el
   precio de enajenación sin disminuir descuentos; si `precioVenta` ya viene neto,
   la base legal es mayor. Esto requiere guardar precio de lista aparte del
   negociado — cambio de MODELO, no de cálculo.

Con las dos, $18.6M debe converger a ~$11.68M. Hasta entonces, NO escribir
`Vehiculo.isan` (calcular al vuelo). Meta de cuadre: el FLUJO de abonos de 2402
(sólo hojas), no el saldo.
Va como etapa de cómputo fiscal del orquestador, y al alta.

## Lo que el orquestador NO resuelve sin bancos

CxC/CxP/IVA en flujo y el balance: necesitan movimientos bancarios. El estado de
resultados SÍ cuadra sólo con FIEL; el balance espera a la conciliación. Es
límite de datos, no del diseño.

## Orden de construcción (cuando se apruebe)

1. Parametrizar los `*-margom.ts` por `--company` (hoy tienen el id fijo).
2. El orquestador `onboard-dealer --company <id>` que encadena las etapas 7–12
   con las compuertas de verificación, extendiendo `onboarding-estado`.
3. El paquete de evidencia + la convocatoria al agente para el nivel 3.
4. El cross-check de CFDIs con cancelados.
5. La cara de asistente (surface las decisiones; niveles 2 pre-resueltos).
