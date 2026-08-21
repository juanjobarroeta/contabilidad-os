# Captura del portal SAT — lo único que falta para reemplazar a Syntage

## Recon del 2026-08-21 — el login con e.firma YA FUNCIONA (medido)

`scripts/recon-sat-portal.ts` entró al portal con la e.firma de ZIONX (empresa
propia, autorizada) y quedó autenticado: el portal mostró `ZIO190321JI6` como
sesión activa. La arquitectura y el contrato del login quedaron mapeados:

- **IdP:** `loginc.mat.sat.gob.mx` (NetIQ Access Manager). Es sólo el proveedor
  de identidad — `/nidp/portal` NO lanza apps («no applications available»);
  cada app federa contra este IdP y, con sesión viva, entra sin pedir nada.
- **Entrada e.firma:** `…/nidp/jsp/main.jsp?id=FormCertiSAT&sid=0` abre en modo
  CIEC (con captcha) y trae un botón `#buttonFiel` que la cambia a e.firma
  **sin captcha**. Tras el clic aparece el formulario `certform` con:
  - `#fileCertificate` (file) — el `.cer`
  - `#filePrivateKey` (file) — el `.key`
  - `#privateKeyPassword` (password) — la contraseña de la LLAVE (no la CIEC)
  - `#rfc` (text, autollenado) · `#submit` (button)
  - ocultos: `token`, `tokenuuid`, `credentialsRequired`
- **Declaraciones y Pagos** (`ptscdecprov.clouda.sat.gob.mx`) usa OTRO realm:
  `loginda.siat.sat.gob.mx` por WS-Federation, con **CIEC + clave dinámica**, no
  la e.firma de loginc. Es su propio login.

Lo que falta descubrir: las URLs de entrada de **CE**, **CSF** y **Opinión
32-D** (mi `buzon.sat.gob.mx` no resuelve — era una adivinanza). Se obtienen con
una pasada más del recon o con el HAR de un click-through (abajo). El login, que
era la parte difícil y reutilizable, ya está resuelto y probado offline en
`src/lib/sat-portal/auth.ts`.

---


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
