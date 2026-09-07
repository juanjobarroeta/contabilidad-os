# Brief de diseño — Mockups para la presentación de Haltus Hope

> **Handoff autocontenido para Claude Design.** Todo lo necesario está aquí; no
> hace falta leer otro documento ni el repositorio.

## 1. Qué es el producto

Un sistema integral para **Haltus Hope**, un hospital privado pequeño en México
(menos de 20 camas, 2 quirófanos). Sustituye la mezcla actual de cuatro sistemas
que no se comunican entre sí.

Es una **aplicación web de escritorio** (los usuarios de piso también la abren en
el celular, pero los mockups son de escritorio). Los usuarios son personal
operativo, no técnico: enfermería, farmacia, caja, compras y dirección.

La idea que organiza todo el producto es **una cadena sin huecos**:

```
expediente → cuenta del paciente → factura → banco → contabilidad
```

Cada eslabón concilia contra el siguiente. Si algo se registró en el expediente,
aparece en la cuenta; si está en la cuenta, ocurrió en el expediente.

## 2. Para qué son los mockups

Van dentro de un deck de PowerPoint que se presenta a la **dirección del
hospital** (dueños, dirección general y administrativa) para venderles el
proyecto. No son especificación de ingeniería: son la prueba visual de que el
producto es real y de que su gente lo va a poder usar.

Consecuencias de eso:
- Deben verse **poblados con datos creíbles**, nunca con texto de relleno.
- Deben leerse **proyectados en una sala**, no a 30 cm de la pantalla.
- Prioridad a la claridad sobre la densidad: es mejor mostrar menos filas y que
  se lean, que llenar la tabla.

## 3. Sistema visual

Tomado de la plataforma real sobre la que corre el producto. **Usar estos
valores exactos.**

| Token | Hex | Uso |
|---|---|---|
| `brand` | `#2D6FCD` | Color primario: botones, estados activos, enlaces |
| `brand-deep` | `#1A52A1` | Hover del primario |
| `brand-tint` | `#ECF4FF` | Fondos suaves, chips, fila seleccionada |
| `brand-ink` | `#184687` | Texto sobre `brand-tint` |
| `jade` / `jade-tint` / `jade-ink` | `#199D78` / `#D9F7EA` / `#005E42` | Éxito, conciliado, pagado, disponible |
| `amber` / `amber-tint` / `amber-ink` | `#DF9B44` / `#FFEBCA` / `#884C1E` | Advertencia, por vencer, caducidad próxima |
| `red` / `red-tint` / `red-ink` | `#D73337` / `#FFE6E3` / `#B32228` | Error, vencido, caducado |
| `ink` | `#1A222E` | Texto principal |
| `ink-soft` | `#515963` | Texto secundario |
| `ink-faint` | `#666C75` | Etiquetas, unidades, texto de apoyo |
| `line` | `#DFE1E5` | Bordes de tarjeta y tabla |
| `line-soft` | `#EEF0F3` | Separadores internos |
| `card` | `#FFFFFF` | Superficie de tarjeta |
| `canvas` | `#F8FAFD` | Fondo de la página |
| `paper` | `#F5F7F9` | Encabezado de tabla, fondos alternos |
| `slate-tint` | `#EDEEF1` | Celdas vacías, estados inactivos |

**Tipografía:** Geist Sans (fallback: Inter, system-ui). Números tabulares o
Geist Mono para dinero, cantidades y folios, para que las columnas alineen.

**Forma:** tarjetas `border-radius: 16px`; controles (botones, inputs, chips)
`11px`. Borde de 1px en `line`. Sombra de tarjeta muy sutil:
`0 1px 2px rgba(45,60,90,.04), 0 8px 24px -16px rgba(45,60,90,.18)`.

**Tema:** claro únicamente. No hacer versión oscura.

### Reglas de estilo

- **Sin barras ni franjas decorativas de color.** Nada de líneas de acento bajo
  los títulos, ni franjas verticales al borde de las tarjetas.
- Separar bloques con espacio en blanco y fondo, no con reglas de color.
- Los estados se comunican con **chips de texto**, no sólo con color, y nunca
  sólo con un punto de color.
- Contraste real: nada de gris claro sobre blanco para texto que importa.

## 4. Estructura de la aplicación

Todas las pantallas comparten el mismo marco:

- **Rail izquierdo angosto (~72px) de puros iconos**, fondo blanco, borde
  derecho `line`. El hospital tiene más de diez módulos y un menú de texto no
  cabe. El icono activo va en `brand` sobre `brand-tint` con esquinas de 11px.
  Módulos, en orden: Inicio · Agenda · Pacientes · Expediente · Cuentas ·
  Farmacia · Compras · Bancos · Mantenimiento · Quejas · Reportes ·
  Configuración.
- **Barra superior**: título de la pantalla a la izquierda; a la derecha
  buscador, campana de avisos y avatar del usuario.
- **Contenido** sobre `canvas`, en tarjetas blancas.

Referencias visuales (estructura, **no** color — su paleta es morada y no se
usa):
- Marco general, rail de iconos y densidad: [Fresha](https://mobbin.com/screens/1b3c5a4b-5f4e-4825-a1c1-a3534bdeeec8)
- Nota clínica de tres paneles: [Heidi](https://mobbin.com/screens/89b184c6-4eb9-4721-8681-dcd54bc72f6c)
- Estado de cuenta: [Wave](https://mobbin.com/screens/5db5bbad-dc14-4305-8f4f-786e8e0bcac6)
- Desglose de cargos con impuestos anidados: [Upwork](https://mobbin.com/screens/7fbfc714-da53-410f-9cb7-412c9852505f)
- Existencias con nivel mínimo: [Fresha](https://mobbin.com/screens/17fb76f9-8b9d-4365-a4e3-dae35775780a)

## 5. Las cuatro pantallas

Cuatro artboards de **1440 × 900**, uno por pantalla.

Un mismo paciente recorre las cuatro pantallas. Que los datos concuerden entre
ellas es parte del encargo: es lo que demuestra la cadena sin huecos.

**El caso:** María Fernanda Ortega Ruiz, 34 años, colecistectomía laparoscópica
el 14 de agosto de 2026 en el Quirófano 2, a cargo del Dr. Alonso Vega.
Aseguradora GNP, póliza 44-882301, deducible $8,500.

---

### Pantalla 1 — Expediente clínico

Tres paneles. Es la pantalla de enfermería y médicos.

- **Panel izquierdo (~280px)** — buscador y lista de pacientes del día, cada uno
  con nombre, edad, cama y un chip de estado. El activo resaltado en
  `brand-tint`.
  - María Fernanda Ortega Ruiz · 34 a. · Cama 204 · chip «Postoperatorio» (jade)
  - Jorge Luis Peña Cárdenas · 58 a. · Cama 201 · chip «Hospitalizado»
  - Silvia Márquez Toledo · 41 a. · Cama 207 · chip «Preoperatorio» (amber)
  - Ramón Aguilar Ceballos · 66 a. · Urgencias · chip «En valoración» (amber)

- **Panel central** — el episodio.
  - Encabezado: nombre, `Episodio HOSP-2026-0418`, ingreso 14 ago 2026 08:20,
    procedimiento, quirófano, médico tratante.
  - Fila de signos vitales como cifras grandes con etiqueta chica:
    TA 118/76 · FC 72 lpm · Temp 36.4 °C · SpO₂ 98% · FR 16 rpm
  - Diagnóstico: chip `K80.20` + «Cálculo de vesícula biliar sin colecistitis».
  - Línea de tiempo de notas, la más reciente arriba, cada una con autor, hora
    y un extracto de dos renglones:
    - Nota postoperatoria — Dr. Alonso Vega — 14 ago, 11:40
    - Nota preoperatoria — Dra. Claudia Rentería (Anestesiología) — 14 ago, 07:55
    - Nota de ingreso — Dr. Alonso Vega — 14 ago, 08:20
    - Historia clínica — Dr. Alonso Vega — 12 ago, 17:10

- **Panel derecho (~300px)** — pendientes del episodio, como lista de tareas con
  casilla:
  - ✅ Consentimiento informado de cirugía — firmado 13 ago
  - ✅ Consentimiento de anestesia — firmado 13 ago
  - ⬜ Nota de egreso — pendiente (chip amber)
  - ⬜ Resultado de patología — en proceso
  - Abajo, tarjeta chica: «Cargos del episodio: **$41,214.80** — ver cuenta →»

---

### Pantalla 2 — Cuenta del paciente

La pantalla de caja. Es la que prueba que la cuenta y el expediente cuadran.

- Encabezado con el paciente, el episodio y un chip verde
  **«Conciliada con el expediente»**.
- Tres tarjetas de resumen arriba: **Consumido $41,214.80** · **Facturado
  $41,214.80** · **Por cobrar $9,860.00**.
- Tabla de cargos agrupada por concepto, con encabezado de grupo en `paper`.
  Columnas: Concepto · Cant. · P. unitario · IVA · Importe.

| Grupo | Renglón | Cant. | P. unit. | IVA | Importe |
|---|---|---:|---:|---|---:|
| Hospitalización | Habitación estándar | 2 noches | $3,200.00 | 16% | $6,400.00 |
| Quirófano | Uso de quirófano | 2.5 h | $4,800.00 | 16% | $12,000.00 |
| Quirófano | Equipo de laparoscopía | 1 | $2,600.00 | 16% | $2,600.00 |
| Farmacia | Cefalotina 1 g · lote L-2291 | 6 pz | $85.00 | 0% | $510.00 |
| Farmacia | Solución Hartmann 1000 ml · lote H-0455 | 4 pz | $62.00 | 0% | $248.00 |
| Estudios | Biometría hemática | 1 | $680.00 | 16% | $680.00 |
| Honorarios | Dr. Alonso Vega — Cirugía | 1 | $18,000.00 | Exento | $18,000.00 |

- Los chips de IVA usan tres tratamientos visibles: **16%** (neutro), **0%**
  (jade-tint), **Exento** (slate-tint). Es un punto de venta: la mezcla fiscal
  de un hospital lleva los tres en el mismo documento.
- Marcar los honorarios con una nota al pie: «facturado por el médico a su
  propio RFC — no es ingreso del hospital».
- **Panel lateral derecho: reparto entre pagadores.**
  - GNP (aseguradora): $31,354.80 — chip «Enviado 15 ago»
  - Paciente (deducible + coaseguro): $9,860.00 — chip amber «Por cobrar»
  - Total: $41,214.80

---

### Pantalla 3 — Farmacia: existencias, lotes y caducidades

La pantalla que vende el módulo nuevo. Debe dejar ver de un golpe qué está por
caducar.

- Tres tarjetas de resumen: **Valor del inventario $1,284,600** · **12 claves
  bajo mínimo** · **7 lotes caducan en 90 días** (esta última en amber).
- Tabla con una fila por **lote**, no por producto. Columnas: Medicamento ·
  Lote · Caducidad · Existencia · Mínimo · Costo unit. · Valor.

| Medicamento | Lote | Caducidad | Exist. | Mín. | Costo | Estado |
|---|---|---|---:|---:|---:|---|
| Cefalotina 1 g sol. iny. | L-2291 | 03/2027 | 148 | 60 | $61.40 | — |
| Ketorolaco 30 mg | K-8830 | **10/2026** | 62 | 40 | $18.90 | Caduca en 54 días (amber) |
| Propofol 200 mg | P-1174 | **09/2026** | 9 | 25 | $214.00 | Caduca en 31 días + bajo mínimo (red) |
| Solución Hartmann 1000 ml | H-0455 | 06/2028 | 310 | 120 | $44.20 | — |
| Midazolam 5 mg | M-0912 | 01/2027 | 24 | 30 | $96.50 | Bajo mínimo (amber) |
| Heparina 5000 UI | HP-3320 | 11/2026 | 55 | 20 | $132.00 | Caduca en 86 días (amber) |

- Las filas en riesgo se distinguen con un chip de estado y un fondo muy tenue
  (`amber-tint` / `red-tint`), **nunca sólo con color de texto**.
- Marcar visualmente el **Midazolam** como sustancia controlada (icono de
  candado chico junto al nombre + chip «Controlado»), para insinuar el control
  que exige COFEPRIS.

---

### Pantalla 4 — Agenda de quirófanos

- Barra de fecha: «Viernes 14 de agosto, 2026», flechas de navegación, botón
  «Hoy», y un botón primario **«Agendar»**.
- Rejilla: **columnas por recurso**, filas por hora de 07:00 a 19:00 en tramos
  de 30 min. Recursos: Quirófano 1 · Quirófano 2 · Sala de endoscopía ·
  Consultorio A.
- Los bloques llevan procedimiento, paciente y cirujano en tres renglones.
  Colorearlos por área con tonos sólidos de la paleta (`brand`, `brand-deep`,
  `jade`), con texto blanco.

| Recurso | Horario | Bloque |
|---|---|---|
| Quirófano 1 | 08:00 – 10:30 | Hernioplastía inguinal · J. L. Peña · Dr. Sandoval |
| Quirófano 1 | 12:00 – 13:30 | Safenectomía · S. Márquez · Dra. Ibarra |
| Quirófano 2 | 08:30 – 11:00 | **Colecistectomía laparoscópica · M. F. Ortega · Dr. Vega** |
| Quirófano 2 | 14:00 – 15:30 | Artroscopía de rodilla · R. Aguilar · Dr. Fuentes |
| Sala de endoscopía | 09:00 – 10:00 | Panendoscopía · C. Villalobos · Dra. Rentería |
| Consultorio A | 16:00 – 19:00 | Consulta externa · 6 citas |

- **Ningún bloque se encima con otro en el mismo recurso.** La pantalla existe
  para probar que el sistema no lo permite.
- Franja horaria actual marcada con una línea delgada en `red` y la hora al
  margen.

## 6. Qué no hacer

- No usar la paleta morada de Fresha ni la de ninguna referencia: sólo los
  tokens de la sección 3.
- No inventar métricas de resultado («−40% de merma»); nada de porcentajes de
  ahorro en las pantallas.
- No poner logotipos ni nombres de aseguradoras reales más allá de «GNP», ni
  nombres de otros productos.
- No usar fotografías de personas. Avatares con iniciales.
- Nada de gráficas de relleno: si una gráfica no dice algo concreto, no va.
- No mostrar terminología fiscal cruda (RFC, UUID, folio fiscal) en pantalla:
  la audiencia es dirección del hospital, no el contador.

## 7. Entrega

Cuatro artboards de 1440 × 900 en un solo canvas, en este orden: Expediente ·
Cuenta · Farmacia · Agenda. Exportables a PNG para insertarse en las láminas
9, 11, 13 y 16 del deck `haltus-hope.pptx`.

## 8. Color — resuelto: la marca de Haltus Hope

El hospital ya tiene identidad propia (haltushope.com): **morado profundo con
acento coral**. Los mockups y el deck usan ESA marca, no la paleta de la
plataforma contable. El objetivo es que la dirección vea su propio sistema, no
un producto genérico.

| Token | Hex | Uso |
|---|---|---|
| `hh-purple` | `#4B4272` | Fondo de superficies oscuras, rail lateral, encabezados |
| `hh-purple-deep` | `#38315A` | Barras superiores, contraste sobre morado |
| `hh-purple-mid` | `#6B5F96` | Bordes y estados sobre morado |
| `hh-purple-tint` | `#EFEDF5` | Fila seleccionada, chips, fondos suaves |
| `hh-coral` | `#F0553F` | Acento y llamadas a la acción — **usar poco** |
| `hh-coral-tint` | `#FDEAE6` | Fondo de alerta suave |

Los tokens neutros de la sección 3 (`ink`, `line`, `paper`, `canvas`, `card`) se
conservan tal cual: son la base gris del sistema y funcionan con cualquier
marca. Los semánticos (`jade` éxito, `amber` advertencia, `red` error) también
se conservan — el coral es acento de marca, no señal de error, y confundirlos
haría ilegible el estado de un renglón.

> Los valores morados y coral están tomados a ojo del sitio público. Si tienen
> el manual de marca, sustituirlos es un buscar-y-reemplazar.
