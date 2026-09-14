# Nómina: el hub que abre en lo que pasó, no en la validación

Fecha: 14-sep-2026. Rama: `docs/nomina-rediseno`. **Estado: en revisión, sin código.**

Lo que pidió el dueño, en sus términos: lo primero que ve en Nómina es
«Validación del cálculo» y debería estar más abajo; quiere ver los últimos
movimientos y la última nómina (expandible, descargable en Excel, descargar
recibos, enviar recibos por correo), los finiquitos; Corridas no distingue
finiquitos de las demás; en Empleados la tabla se corta, quiere descargarla y
una mejor forma de editar (¿en la misma tabla? ¿qué es mejor que un modal?); y
subir contratos.

---

## 1. Lo que ya existe y sólo hay que mover o cablear

| Pedido | Estado real | Qué falta |
|---|---|---|
| Descargar recibos (PDF/XML) | existe por recibo (`descargasPorUuid`, botones PDF/XML/Recibo en Resumen) | el **ZIP de la corrida** completa (un clic, N recibos) |
| Enviar recibos por correo | **no existe** para nómina; `Employee.email` existe; `facturas/[id]/email` es el patrón (Facturapi manda el PDF+XML) | el endpoint por corrida y el botón |
| Excel de la corrida | no existe; `lib/export/xlsx` y la hoja Nómina del export de Facturas (#1018) ya arman la fila del recibo | un endpoint `run/[id]/xlsx` con esa misma fila |
| Tipo de corrida | `PayrollRun.tipo` YA es ORDINARIA/EXTRAORDINARIA/FINIQUITO/AGUINALDO/VACACIONES/PTU, y `Invoice.tipoCorrida` (#1057) lo deriva del XML para las importadas | Corridas no lo **pinta** como categoría: sólo cambia una columna para AGUINALDO/PTU |
| Contratos | `EmployeeDocumento` (tipo, nombre, mime, bytes, archivo) + `GET/POST /api/nomina/empleado/[id]/documentos` + `parse-employee-docs` extrae datos de un contrato en PDF | **la UI**: no hay dónde subirlo ni dónde verlo |
| Dispersión (layout SPEI) | existe (`/api/nomina/dispersion?runId`) | ya cablear en la corrida |

Casi todo es cableado y orden. Lo nuevo de verdad: el ZIP de recibos, el
correo por corrida, el Excel de corrida, y la edición en tabla.

## 2. Resumen: el orden

Hoy: Validación del cálculo (arriba) → Empleados activos → Última corrida →
Este mes → Recibos → Pagos IMSS. La validación es un diagnóstico de cuadre
SAT-vs-app: importa cuando algo no cuadra, no como portada.

Nuevo orden, de arriba abajo:

1. **Últimos movimientos** (nuevo): línea de tiempo de los últimos 10 eventos
   de nómina, mezclados — corrida timbrada, finiquito, alta, baja, dispersión
   enviada, recibo cancelado, incidencia. Cada uno con fecha, quién y enlace.
   Fuente: `PayrollRun` (createdAt/status), `Employee` (fechaIngreso/fechaBaja),
   `AuditLog` (acciones `nomina.*`). Es lo que hoy no existe en ninguna parte.
2. **Última nómina** (expandible): cabecera con periodo · tipo · fecha de pago
   · N empleados · neto; **acciones**: Excel · Recibos (ZIP) · Enviar por
   correo · Dispersión · Ver corrida. Expandida: la tabla de recibos con
   PDF/XML por fila (la que hoy vive abajo en «Recibos»).
3. **Finiquitos y corridas especiales** del ejercicio: chips por tipo con
   conteo y monto — FINIQUITO 4 · AGUINALDO 0 · PTU 0 — cada uno filtra
   Corridas. Aquí vive la respuesta a «¿cuántos finiquitos llevamos?».
4. **Este mes** y **Empleados activos** (los dos cards que ya existen).
5. **Pagos IMSS** (existe).
6. **Validación del cálculo** — al final, y colapsada si cuadra; abierta
   sólo cuando hay diferencia. Sigue existiendo, deja de ser lo primero.

## 3. Corridas: el tipo es una categoría, no una columna

- **Filtro por tipo** arriba: Todas · Ordinaria · Finiquito · Aguinaldo ·
  PTU · Extraordinaria, con conteo. Default Todas.
- **Badge de tipo** en cada corrida, con color: ordinaria sin badge (es la
  norma), FINIQUITO ámbar, AGUINALDO/PTU jade, EXTRAORDINARIA slate. Misma
  paleta que `ETIQUETA_CORRIDA` de Facturas para que el finiquito se vea
  igual en las dos pantallas.
- **Finiquito expandido** enseña lo que lo distingue: fecha de baja, días
  trabajados, partes proporcionales (vacaciones, prima, aguinaldo), indemnización
  si la hay, y el recibo. Hoy se pinta con las columnas de una ordinaria.
- **Acciones por corrida** (las mismas que en «Última nómina»): Excel ·
  Recibos ZIP · Enviar por correo · Dispersión. Una barra, no botones sueltos.

## 4. Empleados: tabla que no se corta, se descarga y se edita en su lugar

**La tabla se corta** porque el contenedor es `overflow-x-auto` con 7
columnas y el nombre/puesto sin ancho mínimo: en 1280 px cabe, en 1024 no.
Arreglo: columnas con `min-width`, el nombre con `truncate` y título, y la
tabla dentro de un contenedor de alto acotado con encabezado pegajoso (el
mismo patrón que se puso en Papeles, #1056).

**Descargar**: botón «Excel» con TODAS las columnas del empleado (no sólo las
7 visibles): RFC, CURP, NSS, fecha de ingreso, antigüedad, puesto,
departamento, tipo de contrato, régimen, periodicidad, SBC, SDI, riesgo,
CLABE, banco, email, Infonavit, Fonacot, estado, último recibo. `lib/export/xlsx`.

**Editar: en la tabla o en un modal.** La respuesta honesta es *depende del
campo*, y la regla es ésta:

- **Edición en línea** (clic en la celda, guarda al salir): los campos
  operativos que se cambian seguido y no tienen efecto legal por sí solos —
  puesto, departamento, email, CLABE/banco, periodicidad. Un cambio, un
  clic, sin ceremonia.
- **Panel lateral** (drawer a la derecha, la tabla se queda visible): los
  campos que cambian el cálculo o el registro ante IMSS y merecen contexto —
  SBC/SDI (con la fecha de vigencia y el aviso de modificación de salario),
  tipo de contrato, régimen, riesgo de puesto, Infonavit/Fonacot. El drawer
  también lleva las pestañas **Documentos** (contratos) y **Recibos** del
  empleado.
- **Modal** sólo para lo irreversible con confirmación: baja/finiquito. Es
  lo único que hoy está bien como modal.

Por qué no todo en línea: cambiar el SBC en una celda y que nadie vea que
eso dispara un aviso al IMSS es exactamente el tipo de error que un drawer
con contexto evita. Por qué no todo en modal: para cambiar un correo, un
modal de 20 campos es ceremonia.

## 5. Contratos

- En el drawer del empleado, pestaña **Documentos**: lista de
  `EmployeeDocumento` (tipo, nombre, tamaño, fecha, descargar) y zona de
  subida. Tipos: contrato, CURP, constancia NSS, identificación, otro.
- Al subir un **contrato** en PDF: se guarda y se pasa por
  `parse-employee-docs`; lo extraído (tipo de contrato, fecha de ingreso,
  sueldo, puesto) se ofrece como **sugerencia** con diff contra lo capturado
  — «el contrato dice SBC $315.59, tienes $300.00 · [aplicar]». Nunca se
  aplica solo.
- Alta de empleado: el mismo flujo empieza por «sube el contrato» y
  prellena el formulario (el parser ya existe; hoy sólo se usa en el
  onboarding con IA).

## 6. Orden de construcción

1. **Resumen reordenado** + «Últimos movimientos» + «Finiquitos y especiales»
   (lectura; datos existentes + AuditLog).
2. **Acciones de corrida**: Excel (reusa la fila de #1018) · ZIP de recibos ·
   Dispersión cableada. Barra única en Última nómina y en Corridas.
3. **Corridas**: filtro y badge por tipo; expansión de finiquito.
4. **Empleados**: tabla que no se corta + Excel.
5. **Drawer del empleado** con edición en línea/drawer/modal según campo,
   y la pestaña Documentos con subida de contrato + sugerencias del parser.
6. **Enviar recibos por correo**: endpoint por corrida (Facturapi `sendEmail`
   por CFDI, como facturas/[id]/email), con reporte de cuáles no tienen email.

1-4 no tocan escritura. 5 y 6 sí; el correo manda algo fuera del sistema y
va al final, con confirmación explícita.

## 7. Lo que este diseño NO decide

- Si «Últimos movimientos» necesita su propia tabla de eventos o basta con
  leer las tres fuentes. Empezar leyendo; si se queda corto, se materializa.
- Firma electrónica de recibos (CFDI de nómina ya es el comprobante legal;
  el acuse de recibido del empleado es otra cosa). Fuera de alcance.

---

## 8. Cumplimiento (IMSS): la opinión, el SIPARE y el SUA

Lo que pidió el dueño: que Cumplimiento enseñe la **opinión IMSS** que ya
sale de SatGo; que la **línea de captura del SIPARE** se encuentre desde la
conciliación bancaria, no que se suba a mano; que el **pago** se lea del banco
(ya tenemos la información); si se puede sacar el **SIPARE** por SatGo o por
scraping; y que **Exportar SUA** deje de estar escondido.

### 8.1 Opinión de cumplimiento IMSS — ya se puede, falta enseñarla

- `GET /api/v2/consultar/imssoc` de SatGo la entrega **con sólo el RFC**
  (sin e.firma, sin cuota del SAT). Verificado el 11-sep-2026 con BAOBAB:
  200, PDF de 776 KB, en 86 s — el IMSS es lento; va como trabajo de fondo.
- `ComplianceSnapshot` ya tiene el tipo `IMSS_OPINION`, `persist.ts` ya lo
  guarda y `diff.ts` ya lo etiqueta. Lo que no existe: **un proveedor que la
  traiga** (`fetchImssOpinion` de Syntage LANZA) y **una tarjeta que la pinte**.
- Diseño: en Cumplimiento, arriba, la tarjeta **Opinión IMSS**: estado
  (positiva / negativa / sin opinión) · fecha · «ver PDF» · «actualizar». Se
  refresca con la cadencia de la opinión SAT (semanal). Al lado, la opinión
  SAT 32-D con la misma forma — hoy ni la SAT se ve en Nómina.
- Es la primera pieza del swap Syntage→SatGo que se cablea en producto: el
  proveedor SatGo detrás de `ComplianceProvider` con `fetchImssOpinion`
  implementado. Prerrequisito: la **API Key durable de prod** en el servicio
  (hoy hay un JWT de preprod que vence el 17-sep).

### 8.2 SIPARE: la línea de captura NO se puede «encontrar» en el banco — el pago sí

Hay que separar dos cosas que hoy se confunden:

1. **La línea de captura** es un dato que EMITE el IMSS (en el SIPARE, antes
   de pagar). El banco NO la trae: el cargo en el estado de cuenta dice
   «IMSS», «SIPARE», «TESOFE» o «pago referenciado» y a veces un folio, pero
   la línea de captura como tal no viaja en la descripción. Encontrarla desde
   la conciliación no es posible.
2. **El pago** sí está en el banco, y ya se cruza: `conciliacion-impuestos.ts`
   sugiere el movimiento que paga una `TaxDeclaration IMSS_MENSUAL` por monto
   y ventana de días, y la mesa lo aplica con `taxDeclarationId`. Eso es lo
   que hay que enseñar en Cumplimiento: **«Pagado el 17/08 · $70,312 · BBVA
   ····4021»** con el movimiento enlazado, en vez de una casilla de subida.

Por eso el diseño es: la tarjeta de cuotas IMSS del mes enseña **estimado ·
pagado (del banco, con enlace a la mesa) · diferencia**, y la línea de
captura queda como dato **opcional** que se captura o se trae del SIPARE
(§8.3), nunca como requisito para registrar el pago.

### 8.3 ¿Se puede traer el SIPARE (emisión, línea de captura, EMA/EBA)?

**SatGo: no.** Su catálogo (swagger reversado, 7-sep) sólo tiene del IMSS la
`imssoc` (opinión) y el REPSE. Nada de emisión mensual/bimestral, línea de
captura, EMA/EBA ni SIPARE. Es un proveedor SAT-céntrico.

**Portal del IMSS (IDSE / Escritorio Virtual / SIPARE): sí, con la e.firma
que ya guardamos.** El patrón entra al IDSE con e.firma (o con usuario+
contraseña del IDSE, que no guardamos). Desde ahí se descarga la **emisión
mensual y bimestral (EMA/EBA)** —que es la base del cuadre que
`sua-reconciliation` ya hace— y el SIPARE genera la **línea de captura**. Es
la misma técnica que la CE del SAT (`abrirBuzonSat` con Playwright): un
worker con navegador, e.firma, y el flujo mapeado. Diferencias honestas:

- El IDSE tiene **captcha en el login por contraseña**; el login por e.firma
  no (mismo patrón que el SAT). Hay que verificarlo en vivo.
- Riesgo de cambio de portal igual que el SAT. El worker de CE ya vive con
  eso.
- Valor: EMA/EBA automáticas cierran el cuadre SUA sin que el contador
  suba archivos; la línea de captura llega sola al mes.

Recomendación: **hacer el piloto** con la misma receta del probe de CE — un
script con Playwright y la e.firma de una empresa, medir si entra al IDSE y
descarga la EMA. Una tarde. Si entra, es el worker `imss-worker` mensual.
Si el login por e.firma pide captcha, se para ahí y se documenta.

### 8.4 Exportar SUA e IDSE: a Resumen, y con contexto

Hoy viven al fondo de Cumplimiento detrás de dos selectores. Diseño:

- En **Resumen**, en la tarjeta **Pagos IMSS** (que ya existe), una barra de
  acciones: **Exportar SUA** (bimestre en curso preseleccionado) · **Exportar
  IDSE** (con el conteo de movimientos pendientes: «3 altas, 1 baja») ·
  **Dispersión**. Un clic, el bimestre correcto por default, cambiarlo si
  hace falta.
- Cumplimiento conserva el bloque completo (con la elección de bimestre y
  ejercicio) para el caso de re-exportar uno anterior.

### 8.5 Orden de construcción (Cumplimiento)

7. **Exportar SUA/IDSE en Resumen** (sólo cableado; un día).
8. **Pago IMSS desde el banco en la tarjeta** (lectura del `taxDeclarationId`
   que la mesa ya escribe; enlace a la mesa; línea de captura opcional).
9. **Opinión IMSS vía SatGo**: proveedor SatGo + tarjeta. Depende de la API
   Key de prod.
10. **Piloto IDSE con e.firma** (EMA/EBA + línea de captura). Una tarde;
    decide si hay worker.
