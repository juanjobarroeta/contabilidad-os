# Alta en 30 minutos: por qué hoy son 6 horas y qué la cambia

Fecha: 2026-09-10. Rama: `feat/onboarding-30min`. **Estado: en revisión de diseño, sin código.**

Meta, con el alcance que fijó el dueño: al terminar el alta, en **≤30 min**, la
empresa tiene

1. backfill de CFDIs **completo**,
2. backfill de CE (balanzas + catálogo) completo,
3. declaraciones y opiniones de cumplimiento,
4. **apertura fiscal completa**: saldo a favor de IVA, pérdidas pendientes de
   amortizar, coeficiente, pagos provisionales previos,
5. cancelaciones aplicadas.

No un cron de 6 h curando lo que el alta no pudo.

Contexto: [DISENO-orquestador.md](DISENO-orquestador.md) ·
[../SAT-NATIVE-DECLARATIONS-FEASIBILITY.md](../SAT-NATIVE-DECLARATIONS-FEASIBILITY.md) ·
[../HANDOFF-inventario-cfdis.md](../HANDOFF-inventario-cfdis.md)

---

## 1. Las cuatro fallas mecánicas que producen las 6 horas

No son «el cron es lento». Son cuatro defectos concretos, verificables en el
código de hoy.

### 1.1 El orquestador está INERTE justo mientras la empresa carga

`cronsPendientes` (`src/lib/onboarding/estado.ts:113`) devuelve los crons de la
**primera etapa incompleta**. La primera etapa es `cfdis`, y su `cron` es `null`:

```ts
{ clave: "cfdis", completa: c.backfillCompleto, cron: null }   // ← etapa 1
etapa("xml", …, "sat-rawxml-backfill")                          // ← etapa 2
```

Con el backfill sin terminar, el bucle sale en la etapa 1 y devuelve `[]`.
`empresasPorAtender` filtra por `crons.length > 0` → **la empresa nueva queda
fuera**. Y `empresasCargando` se calcula con la misma función, así que el
resumen reporta `0`.

Dos consecuencias:

1. La cadena derivada (xml → impuestos → contraparte → vigencia) **no se empuja
   hasta que `satBackfillCompletedAt` queda fijado** — es decir, hasta que los
   60 periodos de 5 años terminaron. No hay razón para esperar: la derivación
   es por factura y opera sobre lo que ya aterrizó.
2. `empresasCargando: 0` es la señal que lee `hayTrabajoPendiente`
   (`src/lib/cron/ritmo.ts`), así que el orquestador se duerme sus **10 min** de
   reposo exactamente durante la carga inicial, que es lo único para lo que existe.

El orquestador construido para acelerar altas nuevas no corre durante un alta nueva.

### 1.2 Dos crons de la cadena son invisibles al ritmo adaptativo

`ritmo.ts` es un contrato **por nombre de llave**, sin tipos que lo obliguen.

| cron | reporta | ¿lo ve el ritmo? | cadencia con rezago |
|---|---|---|---|
| `invoice-contraparte-backfill` | `restantes`, `procesadas` | ✅ | drena a 10 s |
| `sat-vigencia-sync` | `pendientes`, `completado`, `checked` | ✅ | drena a 5 min |
| `invoice-taxes-backfill` | **`remaining`**, `repaired`, `scanned` | ❌ | **6 h siempre** |
| `sat-rawxml-backfill` | **`importedOrBackfilled`**, `perCompany[].remaining` | ❌ | **6 h siempre** |
| `sat-backfill` | `imported`, `totalSubmitted`, sin llave de pendiente | parcial | 5 min si importó, 10 si no |

`invoice-taxes-backfill` **sí** cuenta lo que falta — lo llama `remaining`, en
inglés, y `LLAVES_PENDIENTE` busca `restantes`, en español. Es el mismo defecto
que `ritmo.ts` documenta haber corregido (las 212 mil facturas que drenaban en
26 días), sobreviviendo en dos de los crons que la corrección debía cubrir.

`sat-backfill` es el peor caso intermedio: mientras el SAT prepara paquetes,
`imported` es 0, `hizoTrabajo` es falso, y duerme 10 min — cuando lo que debía
hacer es volver a verificar.

### 1.3 Los empujes del alta están calendarizados para un mundo de 6 horas

`src/app/api/companies/route.ts:657-674`, al guardar la e.firma:

```
kickCron("sat-backfill")                    // +5 s
kickCron("sat-cancel-sync",   10 * 60_000)  // +10 min
kickCron("sat-vigencia-sync", 15 * 60_000)  // +15 min
kickCron("onboarding-drive",  20 * 60_000)  // +20 min
```

El orquestador arranca en el minuto 20 de un presupuesto de 30 — y por §1.1
arranca para no hacer nada. La dependencia que esos retrasos expresan es real;
expresarla con el reloj, no.

### 1.4 La fuga de cuota 5002: reintentos sin backoff ni reaper

`submitSatSync` reutiliza una solicitud existente sólo si está en
`REUSABLE_STATUSES` y tiene menos de 24 h. Una solicitud `FAILED` no es
reutilizable, así que **un periodo que falla crea una solicitud NUEVA en cada
corrida** — y cada solicitud aceptada gasta cuota 5002 de por vida sobre ese
(RFC + rango + tipo). No hay backoff. Tampoco hay reaper: una `IN_PROGRESS`
que el SAT ya expiró se queda `IN_PROGRESS` para siempre.

Medido en BAOBAB (BJQ190709T52, 684 CFDIs en total) el 11-sep-2026:

| año | solicitudes | FINISHED | ACCEPTED sin verificar | IN_PROGRESS | FAILED |
|---|---:|---:|---:|---:|---:|
| 2022 | 105 | 24 | 2 | **76** | 3 |
| 2023 | 74 | 46 | — | 28 | — |
| 2025 | 88 | 48 | — | 27 | 13 |
| 2026 | **611** | 269 | 52 | **142** | **148** |

934 solicitudes para 684 facturas. 273 `IN_PROGRESS` zombis (76 de 2022, que el
SAT expiró hace años), 164 `FAILED` que engendraron una solicitud nueva cada
una, 54 `ACCEPTED` que nadie verificó. Y **de un día para otro 2026 pasó de 607
a 611**: la fuga está viva, ~4 solicitudes diarias para una empresa con 17
facturas en el año.

Es exactamente lo que `DISENO-orquestador.md` pidió como «autocuración del sync
SAT» y nunca se construyó: reaper de colgados, reintento con tramos al fallar,
y detector de huecos. Con granularidad anual (§2) la superficie de la fuga cae
12×, pero la fuga en sí se cierra con esas tres guardas — van en la Ola 0.

### 1.5 Syntage es asíncrono por construcción

`provisionCompany` dispara extracciones y `seguirExtracciones` sondea cada 15 s
hasta 3 h. Opinión y CSF terminan en segundos; las mensuales de 5 ejercicios,
no. El seguimiento está bien hecho: la latencia la pone el proveedor.

---

## 2. La granularidad es la palanca, no la paciencia

### 2.1 Pedimos por MES cuando el SAT acepta cualquier rango

Hoy `sat-backfill` enumera 60 periodos mensuales y `submitSatSync` pide
mes por mes: **5 años = 60 periodos × 2 tipos = 120 solicitudes**, a razón de
`MAX_NEW_SUBMITS_PER_COMPANY = 8` por corrida con piso de 5 min. Sólo *emitir*
las solicitudes toma ~8 corridas = 40-80 min, antes de que el SAT prepare nada.

La Descarga Masiva acepta **cualquier rango de fechas**. Pedido por AÑO son
**5 × 2 = 10 solicitudes**, que caben en 2 corridas (~5 min) y luego se preparan
**en paralelo** del lado del SAT. De 120 trabajos secuenciales por lotes de 8 a
10 trabajos concurrentes.

El mes-por-mes no fue una decisión de diseño: es el eco de la pelea con la cuota
5002 documentada en `HANDOFF-inventario-cfdis.md`, donde un mes quemado se
reabría partiéndolo en **tramos**. La corrección de aquel problema fue *partir
hacia abajo*; nunca se revisó el punto de partida.

### 2.2 El SAT ya nos da la señal para partir: código 5003

El catálogo de `CodeRequest` del SDK trae cinco códigos. El nuestro maneja dos:

| código | nombre | significado | ¿lo manejamos? |
|---|---|---|---|
| 5000 | Accepted | recibida | ✅ |
| 5002 | Exhausted | agotadas las solicitudes de por vida con los mismos parámetros | ✅ |
| **5003** | **MaximumLimitReaded** | **se supera el tope máximo de CFDI o Metadata** | ❌ |
| 5004 | EmptyResult | sin información en el rango | ✅ |
| **5005** | **Duplicated** | ya existe una solicitud vigente con los mismos parámetros | ❌ |

`formatSatError` (`src/lib/sat-sync.ts:66`) cubre 5002 y 5004; **5003 y 5005 no
aparecen en ningún lado del repo**. Nunca han hecho falta porque nunca hemos
pedido un rango que pudiera excederse.

Eso convierte la estrategia en una **cascada determinista**, no en una apuesta:

```
pedir el AÑO
  ├── 5000 → listo, 1 solicitud en vez de 12
  ├── 5003 → partir en semestres → 5003 → trimestres → meses → tramos
  ├── 5002 → ese rango exacto está quemado → bajar un nivel (otra llave de cuota)
  ├── 5005 → ya hay una vigente igual → reusar su requestId, no crear otra
  └── 5004 → sin CFDIs en el año → cerrar los 12 meses de un golpe
```

`partirMes` de `sat-tramos.ts` ya implementa la mitad de abajo con las garantías
correctas (cobertura exacta, sin traslape). Falta la mitad de arriba: `partirAnio`,
con las mismas garantías, y que `SatSyncRequest` sepa representar un rango que
cruza meses.

**5004 sobre un año completo es además un ahorro grande y silencioso**: hoy una
empresa con 3 años sin operar gasta 72 solicitudes para descubrirlo mes a mes.

### 2.3 Corrección a la primera versión de este documento

La primera versión afirmó que 5 años de XML **no caben** en 30 minutos. Esa
conclusión se sacó de la forma actual —120 solicitudes en lotes de 8— y de la
nota de producción de que el SAT tarda «minutos u horas» por paquete.

Con granularidad anual la aritmética es otra: 10 solicitudes emitidas en ~5 min
y preparándose en paralelo. **Si 30 min alcanza deja de ser una cuestión de
principio y pasa a ser un dato empírico: cuánto tarda el SAT en preparar un
paquete de un año.** Nadie lo ha medido — todas nuestras mediciones son de
paquetes mensuales.

**Eso es lo primero que hay que medir, y se mide en una tarde** (§5, Ola 0.5).
El resto del plan depende del número que salga.

---

## 3. La apertura es el entregable, y depende de la cobertura

De los cinco puntos del alcance, el 4 es el que manda: `src/lib/fiscal/apertura.ts`
ya ensambla el punto de partida con procedencia por dato —`ivaSaldoFavor`,
`PerdidaFiscal`, coeficiente, pagos provisionales, obligaciones— para que el
contador lo confirme una vez.

Sus insumos **no son fuentes nuevas**: salen de los acuses de declaración (los
que SatGo entrega síncronos) y del CSF. Así que «saldos de IVA y pérdidas» y
«declaraciones» son el mismo trabajo visto dos veces: lo que falta es que la
apertura quede **armada y confirmable** al minuto 30, no sólo los acuses crudos.

Pero hay una dependencia de **corrección**, no de latencia, que ata la apertura
al backfill de CFDIs:

> `primerPeriodo` = «el mes de la factura timbrada más antigua»

Si el backfill está a medias, `primerPeriodo` se recorre hacia atrás conforme
aterrizan facturas viejas — y el saldo a favor de IVA inicial vive precisamente
en la fila `IVA_MENSUAL` **del mes anterior a ése**. Una apertura confirmada
sobre un backfill parcial se confirma contra el mes equivocado, y todos los
meses posteriores heredan el error. Es justo el fallo silencioso que `apertura.ts`
se escribió para evitar.

**Por eso el dueño tiene razón en pedir el backfill completo dentro de los 30
min y no «convergiendo detrás».** No es impaciencia: la apertura no es
confirmable sin él.

### 3.1 La metadata es lo que fija `primerPeriodo` temprano

`RequestType("metadata")` **ya está implementado en este repo** —
`syncCancelacionesPeriodo` (`src/lib/sat-sync.ts:698`) lo usa para el estatus de
cancelación. Nadie lo ha usado para la carga inicial.

La metadata trae por CFDI: UUID, RFC y nombre de ambas partes, fecha, monto,
efecto (I/E/T/N/P) y estatus de cancelación. Pedida **por año** son otras 10
solicitudes, con llave de cuota **distinta** a las de XML del mismo rango, así
que no compiten. Con eso, sin un solo XML:

- la **fecha del CFDI más antiguo** → `primerPeriodo` queda fijo y correcto
  desde el minuto ~5, aunque el XML siga bajando;
- ingresos y egresos por mes, concentración de clientes y proveedores;
- **cancelaciones de los 5 años completos** (punto 5 del alcance) sin esperar
  la ventana de meses de `sat-cancel-sync`;
- la **prueba de cobertura**: conteo y monto exactos que el SAT dice tener por
  periodo — mejor evidencia que el `cfdisFound` de hoy, y la guarda que
  `sat-cobertura` necesita para afirmar «cobertura completa» sin la trampa #5
  del handoff.

Lo que la metadata **no** trae: `usoCfdi`, `formaPago`, `metodoPago`, subtotal,
desglose de impuestos, partidas. Por eso **no se crean filas `Invoice` desde
metadata**: rellenar esos campos con marcadores metería basura al motor fiscal,
que los lee. La metadata aterriza en su propia tabla; el XML sigue siendo la
única fuente de `Invoice`.

La metadata no sustituye al XML: **lo audita, y desbloquea la apertura antes de
que termine.**

---

## 3bis. El manifiesto: qué existió, y por qué el archivo viejo NO se puede reproducir

### 3bis.1 Sí hay forma de enumerar todo: la metadata ES el manifiesto

La pregunta «¿se puede sondear la lista de CFDIs que alguna vez existieron, para
saber qué buscamos y entonces qué bajar?» tiene respuesta directa: **eso es
exactamente la metadata**. Por cada CFDI que el SAT reconoce devuelve UUID,
fecha, monto, ambas contrapartes y estatus de cancelación — sin bajar un solo
XML, y pedida por año son 10 solicitudes.

Eso cambia la definición de «backfill completo». Hoy es una inferencia:
`satBackfillCompletedAt` se fija cuando los 60 periodos tienen fila FINISHED, y
`coberturaSospechosa` compara conteos para adivinar si un mes marcado «hecho»
de verdad trajo facturas. Con el manifiesto es una **resta**: manifiesto − lo
nuestro = la lista exacta de UUIDs que faltan, y «completo» es esa lista vacía.
Se acaban las cinco trampas de medición del handoff, porque el eje deja de ser
la tabla auditada y pasa a ser el censo del SAT.

`scripts/probe-sat-horizonte.ts` hace justo eso, en cuatro fases: inventario
propio (BD, gratis) → manifiesto (metadata por año) → diff → un año de XML
cronometrado. Corre en seco por defecto.

### 3bis.2 El horizonte de «5 años» NUNCA se midió — corrección

La primera versión de esta sección decía que la ventana de ~5 años «ya está
medida» porque `HANDOFF-inventario-cfdis.md` la cita («Emitidas 2018-06,
2018-10, 2020-06 · fuera de la ventana de 5 años»). **El censo del 11-sep lo
desmiente:** para MARGOM, los años 2017-2020 aparecen como `NUNCA_PEDIDO` — no
hay una sola fila de `SatSyncRequest` para ellos. El handoff *infirió* la
ventana de tres meses que faltaban; nuestro sistema jamás le preguntó al SAT.

Eso reabre la pregunta de fondo (§3bis.3): si no hay ventana medida, que
Syntage haya sacado XML real de 2017-2020 con una FIEL de 2026 deja de ser un
misterio y pasa a ser la hipótesis más simple — **el SAT sí los sirve, y
nosotros nunca los pedimos**.

El probe lo mide de verdad, y barato: se barre del año más viejo al más nuevo
y los que de verdad estén fuera de ventana contestan **5004 (vacío)** en
segundos. **MARGOM es el candidato ideal para esta medición:** sus 2017-2020 ya
están completos en BD (203,617 CFDIs, todos con `rawXml`), así que la cuota que
gaste la prueba no compra nada que haga falta — sólo la respuesta.

### 3bis.3 Lo que Syntage tiene de antes de 2021 es un ARCHIVO, no una técnica

MARGOM tiene CFDIs desde 2017-11 —~10,600 que entraron por Syntage— de un rango
que «el SAT no da nunca». La explicación no es que Syntage sepa entrar por otra
puerta: es que **Syntage venía jalando ese RFC desde que ese rango todavía
estaba en ventana**. Guardaron una foto que el SAT ya no sirve.

Tres consecuencias, y la tercera es la que manda:

1. **No se puede reproducir.** Ni con nuestra descarga masiva, ni con SatGo —
   cuyo `facfiel` es un envoltorio de la misma descarga masiva y hereda la misma
   ventana. Ninguna palanca de este diseño recupera un CFDI fuera de ventana.
2. **Y en buena parte ya está agotado.** El handoff lo midió: Syntage tiene los
   folios pero **no los XML de 2022-2025** (`xml: false` → `GET /invoices/{id}/cfdi`
   da 404); de 32 XMLs que sí entregó, ya teníamos los 32. Lo que queda de ellos
   son folios y **PDFs — y un PDF no es un CFDI**: no da desglose de impuestos ni
   complementos, y los de MARGOM ni siquiera traen el NIV (traen `No Motor:`).
   Esa población es exactamente la que la Fase 0 del probe cuenta como `sinXml`.
3. **Es un riesgo de la cancelación, NO del alta de 30 minutos.** Para un cliente
   NUEVO, Syntage tampoco tiene nada fuera de ventana —empieza de cero igual que
   nosotros—, así que la meta de 30 min no depende de esto en absoluto. El riesgo
   es para los clientes **ya cargados**: lo que Syntage guarde fuera de nuestra
   ventana se pierde para siempre el día que se cancele el contrato.

**Lo que el censo demostró (11-sep-2026, 18 empresas con e.firma):** sólo
**MARGOM** tiene años que entraron por fuera (2017-2020), y **los 203,617 CFDIs
de MARGOM traen `rawXml`** — el archivo de Syntage ya está íntegro en nuestra
base. Las otras 17 nunca recibieron un CFDI de Syntage (sólo opinión, CSF,
declaraciones y CE). **No hay nada que extraer antes de cancelar.**

La regla de cutover se reduce a: correr el censo una vez más el día del corte
(`scripts/probe-sat-horizonte.ts`, dry run, gratis) y confirmar que sigue
saliendo `1 de 18` con `sinXml = 0`.

Ojo con la lectura de `rawXml`: **no dice de dónde vino.** La descarga masiva y
el cron `syntage-cfdis` importan por la misma `importarCfdiXml`. La procedencia
se infiere de los rastros —`SatSyncRequest` (pedimos nosotros) contra
`CostEvent categoria=SYNTAGE` (pagamos a un tercero)— y eso es lo que el censo
cruza.

---

## 4. Las otras dos palancas

### 4.1 SatGo sustituye a Syntage y además lo vuelve SÍNCRONO

El cambio de vendor se justifica por costo (~$10 MXN/RFC/mes vs ~$170-300 por
entidad), pero para esta meta importa otra cosa: **la familia `*fiel` responde
en la misma llamada HTTP**. Desaparece el ciclo `createExtraction` → sondeo →
cosecha, y con él la única latencia del carril de cumplimiento que no controlamos.

Verificado en vivo (prod, BARTIZ CBA170606FQ8, 9-10 sep 2026): API Key durable →
`POST /api/Auth/token-json` → JWT + header `Rfc`; `csffiel` → 200 PDF 3 pp;
`decfiel?ejercicio=2025&mes=0` → 200 ZIP con 12 acuses. Todo con la e.firma que
ya guardamos: **cero CIEC, cero captcha**.

Encaje con lo que existe:

- el acuse llega como PDF, que es lo que `parseSatDocument` ya come → el swap es
  de **transporte**, no de parser ni de esquema; `TaxDeclaration` no cambia;
- la e.firma ya está guardada y cifrada — es el material que piden los `*fiel`;
- va detrás de `ComplianceProvider`, que ya anticipa proveedores intercambiables.

Lo que SatGo **no** tiene: `balanza`/`catálogo`/`contabilidad`. **No ofrece CE.**
La CE propia no es redundante con SatGo — es complementaria, y es la única pieza
que Syntage cubría y SatGo no.

Probar antes de cablear: si `decfiel` acepta un `tipoDocumento` que devuelva
datos estructurados en vez de PDF, se ahorra el parseo con LLM de ~60 acuses en
la ruta crítica.

### 4.2 La CE propia, bajo demanda en el alta

`ce-worker` (Railway, `Dockerfile.ce-worker`) ya baja balanzas y catálogo con
Playwright + e.firma y corre en producción — pero en cron **mensual, día 6**
(`0 13 6 * *`). Una empresa dada de alta el día 7 espera 30 días.

El alta debe disparar el worker **para esa empresa** al guardar la e.firma. Es el
mismo `abrirBuzonSat` + `descargarCeAnioSat` ya validados; falta la invocación
por empresa.

Prerequisito conocido: el servicio `ce-worker` en Railway todavía apunta a
`feat/ce-descarga-sat`, no a `main`. Repuntarlo va primero.

---

## 5. Plan de construcción

**Ola 0 — destrabar el ritmo (horas, riesgo bajo).** Correcciones mecánicas:
bajan la cola de 6 h sin cambiar arquitectura y valen aunque todo lo demás se
posponga.

1. `ritmo.ts`: aceptar `remaining` además de `restantes`, y **una prueba que
   recorra las rutas de cron y falle si un resumen no expone ninguna llave del
   contrato** — el defecto es del contrato sin tipos, no de un cron.
2. `sat-rawxml-backfill`: exponer `restantes` (suma de `perCompany[].remaining`)
   y renombrar `importedOrBackfilled` a una llave de `LLAVES_HECHO`.
3. `sat-backfill`: exponer `restantes` para que drene a su piso de 5 min
   mientras espera al SAT, en vez de dormir 10.
4. `onboarding/estado.ts`: que la etapa `cfdis` **no bloquee** las derivadas —
   devolver los crons de la primera etapa incompleta **que tenga cron**, y contar
   la empresa en `empresasCargando` aunque su único pendiente sea el backfill.
5. `companies/route.ts`: quitar los retrasos de 10/15/20 min; encadenar por
   evento (`encadena`) en vez de por reloj.
6. **Cerrar la fuga de cuota** (§1.4): (a) reaper — una `IN_PROGRESS` con más
   de 72 h pasa a `EXPIRED` y deja de contar como «en vuelo»; (b) una `FAILED`
   NO engendra una solicitud idéntica: el siguiente intento va con el rango
   partido (`partirMes`, que ya existe) o espera un piso de días; (c) una
   `ACCEPTED` sin verificar en 24 h se verifica antes de pedir nada nuevo.

**Ola 0.5 — MEDIR antes de diseñar más (una tarde).** `scripts/probe-sat-horizonte.ts`,
ya escrito y desplegado como worker `sat-probe` en Railway. De aquí salen los
cuatro números que deciden todo lo demás:

7. Correr en **seco** primero (imprime qué pediría, no toca al SAT). Revisar la
   Fase 0: cuántas filas `sinXml` tiene la empresa — ése es el archivo heredado.
8. Correr con `PROBE_APLICAR=1` contra **una** empresa con e.firma — **MARGOM**,
   por §3bis.2. Salen:
   · **horizonte** — el año más viejo con datos, y cuáles contestan 5004;
   · **¿cabe el año?** — si algún lado devuelve **5003**, el año no cabe en una
     solicitud y hay que partirlo; si ninguno, la granularidad anual es válida;
   · **tiempo de preparación del SAT** por solicitud anual, metadata vs XML —
     el número que decide si 30 min es alcanzable;
   · **el diff** — la lista exacta de UUIDs cuyo XML falta.
9. Con `PROBE_XML_ANIO=<año>` agrega el año de XML cronometrado (Fase 3).
10. Con esos números: ¿30 min es alcanzable con granularidad anual? Si sí, el
   alcance del dueño se cumple tal cual. Si no, la metadata (§3.1) sostiene la
   apertura mientras el XML converge, y la promesa al cliente se redacta sobre eso.

**Cuidado, y es serio:** cada solicitud aceptada quema la cuota 5002 de ese
(RFC + rango + tipo) **de por vida**. El probe deja bitácora append-only de todo
lo que emite y no reintenta rangos dentro de una corrida, pero no hay deshacer.
Correr en seco primero, y elegir a conciencia la empresa del ensayo.

**Ola 1 — granularidad anual con cascada (días).**

8. `partirAnio` en `sat-tramos.ts`, con las mismas garantías que `partirMes`
   (cobertura exacta, sin traslape).
9. `SatSyncRequest` capaz de representar un rango que cruza meses; revisar
   `coberturaDe` y las cinco trampas de medición del handoff con la nueva forma.
10. Manejo de **5003** (partir) y **5005** (reusar el requestId vigente) en
    `formatSatError` y en el flujo de submit.
11. `sat-backfill` arranca por año y desciende sólo cuando el SAT lo pide.

**Ola 2 — metadata como auditoría y desbloqueo de la apertura (días).**

12. Tabla de panorama + submit de metadata por año, reusando el patrón de
    `syncCancelacionesPeriodo`.
13. `primerPeriodo` de `apertura.ts` se toma de la metadata, no del `Invoice`
    más antiguo importado.
14. `sat-cobertura` recalculada sobre metadata; cancelaciones de 5 años
    aplicadas desde ahí.

**Ola 3 — SatGo síncrono (días).**

15. Cliente detrás de `ComplianceProvider`: auth, `csffiel`, `ocfiel`,
    `informacionfiscalfiel`.
16. `decfiel` por ejercicio → unzip → `parseSatDocument` → `TaxDeclaration`.
17. Correr **en sombra** contra Syntage y comparar filas antes de cortar.

**Ola 4 — CE en el alta.** Repuntar `ce-worker` a `main`; invocación por empresa
desde el alta; borrar `feat/ce-descarga-sat`.

**Ola 5 — apagar Syntage.** Sólo cuando 15-17 corran en sombra sin divergencia.
La precondición de archivo (§3bis.3) **ya está cumplida**: el censo demostró
que lo único que Syntage trajo de fuera —MARGOM 2017-2020— ya está íntegro en
BD. Re-correr el censo el día del corte y listo. Syntage es la red, no el
objetivo.

---

## 6. Lo que este diseño NO resuelve

- **Recibidas canceladas.** La descarga masiva no las entrega, nunca. La
  metadata sí las ve: por primera vez el hueco queda *medido* en el alta en vez
  de sólo documentado.
- **CFDIs fuera de la ventana de ~5 años.** Ninguna palanca de aquí los
  recupera (§3bis.3). Para clientes nuevos da igual; para los ya cargados es un
  riesgo de cutover, no de latencia.
- **La cuota 5002 ya gastada.** Se consume también fuera de nuestro sistema
  (Syntage usa la misma FIEL). Una empresa que llega con meses quemados no se
  arregla con granularidad; se arregla con tramos, como hoy.
- **CxC/CxP y balance.** Necesitan bancos. Límite de datos.
- **La mitad de cuadre** (etapas 7-12 de DISENO-orquestador.md). Otro problema:
  éste es de latencia y cobertura, aquél es de juicio contable.

## 7. Suelto, verificar aparte

`parseSatDocument` fija el modelo en `claude-sonnet-4-5`. Está en la ruta crítica
(hasta ~60 acuses por alta). Vale revisarlo contra el catálogo de modelos vigente
antes de tocar throughput — no se cambió aquí.
