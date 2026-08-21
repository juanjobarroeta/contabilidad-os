# Captura del portal SAT — lo único que falta para reemplazar a Syntage

La firma con la e.firma ya está construida y probada (`src/lib/sat-portal/auth.ts`,
11 pruebas verdes, todas offline). Lo que no se puede inventar desde el código es
la **forma exacta de las peticiones del portal**: qué URL sirve el reto, qué
campos lleva el formulario, cómo se llama la cookie de sesión, cuántos redirects
hay. Eso se obtiene con **una captura real** y a partir de ahí todo es cliente
HTTP tipado contra fixtures — sin navegador, sin agente, sin adivinar contra la
credencial de un cliente.

## Por qué con captura y no con un agente que navegue

Un agente clickeando el portal en vivo es lento, no determinista, se rompe en
silencio cuando el SAT cambia el marcado, y gasta una credencial real en cada
intento fallido. La captura hace lo contrario: se graba UNA vez el tráfico
auténtico, se vuelve fixture, y el cliente se construye y se prueba **offline**
contra ese fixture. Las corridas en vivo son al final, supervisadas, una por
fuente.

## Qué capturar — la manera más limpia (HAR)

1. Abre el navegador con las herramientas de desarrollador → pestaña **Red
   (Network)**. Marca **«Preservar registro» (Preserve log)**.
2. Entra a https://www.sat.gob.mx → **Trámites** → inicia sesión **con e.firma**
   (NO con CIEC/contraseña — la e.firma es la que no tiene captcha). Sube el
   `.cer`, el `.key` y la contraseña de la FIEL de **MARGOM** (su propia
   credencial, no la de un tercero).
3. Ya dentro, entra a **cada** una de estas tres, para que el HAR incluya su
   tráfico:
   - **Declaraciones y Pagos** → la lista de declaraciones presentadas, y abre
     **un acuse** (el PDF).
   - **Contabilidad Electrónica** (Buzón Tributario → Contabilidad) → la lista
     de envíos, y descarga **un acuse/paquete** (el .zip).
   - **Constancia de Situación Fiscal** → genera la CSF (PDF), y la **Opinión de
     Cumplimiento 32-D**.
4. En la pestaña Red: clic derecho → **«Guardar todo como HAR» (Save all as
   HAR)**. Mándame ese archivo.

> El HAR trae encabezados y cookies de una sesión real: es material sensible.
> Tras extraer las fixtures se borra; nada de lo sensible entra al repo ni a mis
> respuestas.

## Alternativa: captura supervisada por mí

Si prefieres, un script desechable hace **un solo** login con la FIEL de MARGOM
y vuelca las respuestas crudas a disco, contigo mirando. Un login, no un ciclo.
Es más rápido que el HAR pero requiere correr la credencial una vez en vivo.

## Qué saco del HAR y qué construyo con eso

| del HAR | fixture | módulo que habilita |
|---|---|---|
| URL + campos del formulario de login | `login.reto.html` | confirma `auth.ts` y prende `session.ts` |
| respuesta del POST de login (set-cookie) | `login.respuesta` | `session.ts` (la cookie de sesión) |
| lista de Declaraciones y Pagos | `declaraciones.lista.json/html` | `declaraciones-sat.ts` |
| un acuse de declaración (PDF) | ya lo parsea `parseSatDocument` | — |
| lista de Contabilidad Electrónica | `ce.lista.*` | `ce-sat.ts` |
| un paquete CE (.zip) | ya lo abre `descarga-xml.ts` | — |
| CSF y Opinión 32-D | `csf.*`, `opinion.*` | `SatDirectComplianceProvider` |

## Cómo se despliega sin riesgo

- Cada fuente entra detrás de la interfaz que ya existe (`ComplianceProvider`) o
  una nueva del mismo estilo; **Syntage sigue activo en paralelo** y se comparan
  las salidas un mes completo antes de apagarlo.
- Orden por dolor, no por completitud: **declaraciones primero** (es lo que
  disparó el ciclo de costos de parseo, y el parser ya está probado), CE
  después, opinión/CSF al final.
- Los CFDIs **no** entran en alcance: ya se traen del SAT por descarga masiva,
  más completos que Syntage (medido: de 120k que lista Syntage, sólo 91 no
  estaban, y ninguno con XML que ellos tuvieran).
