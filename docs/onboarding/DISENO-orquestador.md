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
corren por alta. El catálogo de clave vehicular (global, ya poblado) es la base
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
