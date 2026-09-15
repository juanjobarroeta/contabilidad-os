# Copiloto jurídico: contrato entre el hub y la app

Quién es quién: la app (`juanjobarroeta/copiloto-juridico`, Next en el 3200)
pinta; el hub (`contabilidad-os`: `src/app/api/juridico/*`, `src/lib/juridico/*`,
`prisma/`) decide y guarda. Este documento es lo que la app puede dar por cierto.
Cuando el hub cambia algo de aquí, lo escribe aquí primero.

Respuesta al handoff de la sesión de rediseño (14-sep-2026).

---

## 1. Citas con estado propio: HECHO

Sí es factible y ya está. No hace falta un mapa de posiciones caro: los offsets
salen del mismo regex que ya detectaba las citas, sobre el texto **entregado**
(el corregido, si la verificación corrigió). Cero llamadas extra al modelo.

`JuridicoMensaje.meta.citas` de cada mensaje del asistente:

```ts
{
  id: string;              // "c1", "c2" — estable dentro del mensaje
  inicio: number;          // offset en el texto entregado
  fin: number;
  textoEnRespuesta: string;// "artículo 486 del CPF"
  cita: string;            // normalizada: "ART. 486 CPF"
  fundamento: {            // la norma en que descansa; null si no se encontró
    cita: string;          // "Art. 486 CHH-C-PROCEDIMIENTOS-FAMILIARES-CH"
    ley?: string;
    articulo?: string;
    titulo?: string;       // "Código de Procedimientos Familiares del Estado de Chihuahua"
    url?: string;
  } | null;
  estado: "verificada" | "corregida" | "observada" | "fuera_de_base" | "sin_verificar";
  motivo?: string;         // por qué el verificador la marcó
}[]
```

Son cinco estados, no tres, porque tres mentirían:

| estado | qué pasó | qué debería mostrar la UI |
|---|---|---|
| `verificada` | Se resolvió a una norma real y el verificador no objetó nada. | Normal, clicable. |
| `corregida` | El verificador objetó y su corrección **sí** se aplicó al texto. | Marca discreta; el texto ya está bien. |
| `observada` | El verificador objetó y su corrección **se descartó** (encogía la respuesta o metía citas nuevas). El texto es el original. | Advertencia: el abogado tiene que revisarla. |
| `fuera_de_base` | La cita no existe en el corpus. | Advertencia fuerte. |
| `sin_verificar` | El pase no corrió (`AI_VERIFICACION_JURIDICO=0` o respuesta sin citas). | Neutro, sin promesa de verificación. |

`observada` es el caso que la UI no debe pintar como `corregida`: es el único en
que el texto entregado tiene un problema conocido y sin arreglar.

**Citas en prosa: ya cubiertas.** «El artículo 486 del Código de Procedimientos
Familiares del Estado de Chihuahua» se reconoce por el TÍTULO contra el catálogo
cargado (2 361 ordenamientos), se resuelve a su clave y entra tanto a `citas[]`
como al verificador. Antes sólo se reconocía la forma corta con siglas
(«Art. 27 LISR»), que es como escribe el copiloto contable pero casi nunca el
jurídico: esas afirmaciones no se verificaban ni se marcaban.

**Lo que sigue sin marcarse:** una referencia sin número de artículo («conforme
al Código Civil de Puebla») y un ordenamiento que el copiloto invente —ése no
casa con el catálogo, y el verificador lo seguirá marcando como no verificable,
que es lo correcto—. La UI no debe asumir que `citas[]` cubre todo lo que el
texto afirma.

**`fundamentos[]` no cambia y sigue sin ser «las fuentes de esta respuesta».** Es
lo que la búsqueda **devolvió** en el turno, con su similitud: sirve para
explicar en qué se apoyó el copiloto, no para afirmar que la respuesta lo citó.
Lo que la respuesta cita es `citas[]`. No las mezclen en un mismo panel sin
distinguirlas.

Dónde vive: `construirCitas()` en `src/lib/ai/verificacion.ts` (puro, con
pruebas); `citasConPosicion()` en `src/lib/ai/eval/medidas.ts`. El turno lo
llama en `src/lib/juridico/turno-abogado.ts` y queda en `meta` del mensaje, así
que llega igual por SSE (`done.traza`) y al releer la conversación.

## 2. Reparto de repos: de acuerdo

La app es de la sesión de rediseño; el hub es de ésta. Con dos apuntes:

- El hub también manda en el **contrato de datos** (esquema, rutas, eventos SSE).
  Si una pantalla necesita un campo, se pide aquí y el hub lo agrega; la app no
  infiere ni deriva lo que el hub no promete.
- La app puede tocar el hub sin preguntar en un caso: agregar una ruta al matcher
  de CORS en `src/middleware.ts` cuando estrene un endpoint ya existente. Es un
  renglón y su ausencia se manifiesta como «Load failed» sin status en Safari.

## 3. Qué hay en vuelo en `src/app/api/juridico/*` (importante)

Sí, bastante, y de hoy:

- **`chat/route.ts` se reescribió** (PR #1082, ya en `main`). El cuerpo del turno
  salió a `src/lib/juridico/turno-abogado.ts`; la ruta sólo autentica, arma el
  contexto y devuelve la vista SSE. Cualquier rama que edite ese archivo con el
  contenido viejo va a chocar feo: **rebase antes de tocarlo**.
- **Turnos durables**: nueva tabla `JuridicoTurno` (migración `20260923`) con los
  eventos SSE y un checkpoint por ronda. Consecuencia para la app: `GET
  /api/juridico/chat?conversacionId=&desde=N` ahora reproduce el turno **desde la
  base** cuando el contenedor que lo corría murió; el `204` quedó sólo para «no
  hay turno reciente». Probado en producción: un turno sobrevivió cuatro
  redespliegues. La app no necesita cambiar nada, pero ya no debería tratar un
  corte de stream como respuesta perdida.
- **Evento `replace`**: al reanudar, el turno manda `replace` con el texto del
  checkpoint. La app ya lo maneja; si la nueva UI reescribe el consumidor de SSE,
  `replace` **sustituye** el texto acumulado, no lo concatena.
- `/api/auth/change-password` entró al matcher de CORS (PR #1085).
- `/api/cron/ia-salud` (PR #1089) no es superficie de app.

## 4. Casos, clientes, tareas y bitácora (Fase 1) — ESQUEMA YA ESCRITO

Migración `20260924_juridico_casos`. Lo que la app puede dar por cierto:

**`JuridicoCaso`** es el contenedor. Ojo: la TABLA se sigue llamando
`JuridicoAsunto` (`@@map`) y la columna `JuridicoConversacion.casoId` sigue
siendo `asuntoId` en SQL. Renombrarlas obligaría a parar el producto durante el
rollover, porque el contenedor viejo consulta los nombres viejos mientras el
nuevo arranca. En Prisma y en la API todo se llama **caso**.
Campos nuevos: `estado` (`abierto` | `en_tramite` | `cerrado`),
`responsableUserId`, `clienteId` (ficha del directorio) y `cerradoAt`. Lo demás
—materia, vía, autoridad, expediente, entidad, objetivo, decisiones, partes— no
cambia.

**`JuridicoCliente`** es el directorio del despacho: `tipoPersona`, `nombre`,
`nombreNormalizado` (sin acentos ni forma societaria, para deduplicar y buscar),
`rfc`, `curp`, `domicilio`, `representante`, `email`, `telefono`, `notas`,
`verificado`. `JuridicoParte` gana `clienteId`: la parte es el PAPEL que alguien
juega en un caso; el cliente es quién es. `candidatos()` propone fusiones por
RFC, CURP o nombre normalizado y **nunca** fusiona solo.

**`JuridicoTarea`**: `casoId`, `titulo`, `detalle`, `estado` (`por_hacer` |
`en_curso` | `en_revision` | `hecha` | `cancelada`), `prioridad`
(`baja` | `normal` | `alta`), `vence`, `asignadoUserId`, `creadaPorUserId`,
`documentoId`, `origen` (`manual` | `copiloto` | `acuerdo`), `hechaAt`.
Helpers puros para la UI en `src/lib/juridico/tareas.ts`: `urgencia()` devuelve
`vencida | hoy | proxima | lejana | sin_fecha | cerrada` con los días, y
`ordenarTareas()` pone primero lo que urge y al final lo cerrado. Una tarea
cerrada sólo se reabre a `por_hacer` o `en_curso` (`transicionValida`).

**`JuridicoDocumentoVersion`**: `n` consecutivo, `texto`, `plan`,
`autorUserId`, `autorTipo` (`abogado` | `cliente` | `copiloto`), `autorNombre`
(para el cliente que revisa por enlace y no tiene cuenta), `motivo` y
`seccionesCambiadas` (`[{ n, titulo, cambio: "agregada"|"editada"|"eliminada" }]`,
calculado por número de sección). Es lo que alimenta **W-06 Comparar versiones**.
El JSON viejo `JuridicoDocumento.versiones` sigue ahí para no romper nada, pero
ya no se escribe: lo nuevo va a la tabla.

**`JuridicoBitacora`**: append-only por caso. `actorUserId`, `actorTipo`
(`abogado` | `cliente` | `copiloto` | `sistema`), `actorNombre`, `accion`
(`caso.creado`, `parte.registrada`, `documento.version`, `tarea.movida`,
`comentario.cliente`…), `entidad`, `entidadId`, `resumen` (frase ya redactada,
en español) y `datos`. Alimenta **W-09 Bitácora**; `frase()` arma el renglón.
Apuntar nunca tumba la operación que lo generó: si la escritura falla se
reporta y la acción sigue.

**`JuridicoDocumento.casoId`**: se hereda de la conversación (la migración ya
rellenó lo existente), para que un documento siga vivo en el caso aunque su
conversación se archive.

### Rutas (ya existen)

| Ruta | Qué hace |
|---|---|
| `GET /api/juridico/casos?estado=&q=` | Lista con conteos por estado, partes, documentos, conversaciones, pendientes abiertos y próximo vencimiento. |
| `POST /api/juridico/casos` | Abre un caso. |
| `GET /api/juridico/casos/[id]` | Ficha completa: partes, decisiones, cliente, conversaciones, documentos y tareas. |
| `PATCH /api/juridico/casos/[id]` | `estado`, `responsableUserId`, `clienteId`, o `moverConversacionId` para traer una conversación al caso. |
| `GET/POST /api/juridico/casos/[id]/tareas` | Pendientes del caso; POST acepta una o varias. |
| `PATCH/DELETE /api/juridico/tareas/[id]` | Mover, asignar, reprogramar o quitar. |
| `GET /api/juridico/casos/[id]/bitacora` | Append-only, lo nuevo primero, con `frase` ya redactada y el nombre del actor resuelto. Paginación con `antesDe`. |
| `GET/POST /api/juridico/clientes` | Directorio y alta. El alta responde **409 con `candidatos`** si detecta un posible duplicado; `forzar: true` la fuerza y `comprobar: true` sólo consulta. |
| `GET/PATCH /api/juridico/clientes/[id]` | Ficha, en qué casos aparece y con qué papel. |
| `GET /api/juridico/documentos/[id]/versiones` | Historial con autor, motivo y secciones cambiadas; `?n=3` devuelve el texto de esa versión (W-06). |

Todas cuelgan de `/api/juridico/:path*`, que ya está en el matcher de CORS.

### Notas de voz

`POST /api/juridico/transcribir` — multipart con el campo `audio`; devuelve
`{ texto, segundos, aviso? }`. Hasta 25 MB. El costo entra al asiento como
`ai.juridico.voz` y respeta el tope (429 `JURIDICO_TOPE_MES`).

**Regla de producto: la nota NO dispara un turno.** El texto cae en el cuadro
de escribir para que el abogado lo corrija antes de enviarlo; lo que dicta
lleva nombres, cifras y plazos, y un dictado mal entendido que se manda solo
es peor que teclear. La app ya trae el botón (`components/BotonDictar.tsx`):
graba hasta 5 minutos con reloj, toma el formato que soporte el navegador
(Safari mp4, Chrome webm) y agrega el texto al final de lo ya escrito.

### Consumo y asientos

| Ruta | Qué hace |
|---|---|
| `GET /api/juridico/consumo` | Lo que lleva gastado el asiento este mes (USD), su tope, la fracción, `avisar` al 80 %, `excedido`, y en qué se fue (consultas, verificación, lectura, transcripción). |
| `GET/POST /api/juridico/usuarios` | Asientos y alta. **Sólo operador.** El alta devuelve `contrasenaTemporal` **una vez** (null si la cuenta ya tenía contraseña). |
| `PATCH /api/juridico/usuarios/[id]` | `{ restablecer: true }` → contraseña nueva, una sola vez. **Sólo operador.** |
| `DELETE /api/juridico/usuarios/[id]` | Quita el acceso sin borrar la cuenta ni sus casos. **Sólo operador.** |

### El despacho (la cuenta)

Un caso ya no es de UNA persona: es del **despacho**, y lo ve quien sea miembro.
`userId` se conserva en el caso —dice quién lo abrió— pero el acceso es
«mío O de mi despacho» (`alcance()` en `src/lib/juridico/despacho.ts`).

| Ruta | Qué hace |
|---|---|
| `GET /api/juridico/despacho` | El despacho, su equipo y `puedo` (administrar, cerrar caso, redactar). **Si el abogado no tiene despacho se le crea uno** (él como socio) y sus casos y clientes se mudan ahí: no hay pantalla de «crea tu despacho». |
| `PATCH /api/juridico/despacho` | Renombrarlo (sólo socio). |
| `GET/POST /api/juridico/despacho/miembros` | El equipo, y sumar a alguien: si no tiene cuenta se le crea con acceso y `contrasenaTemporal` que se enseña **una vez**. Sólo socio. |
| `PATCH/DELETE /api/juridico/despacho/miembros/[userId]` | Cambiar papel o sacar del despacho. Sólo socio. Un despacho **nunca se queda sin socio**, y sacar a alguien no borra su cuenta ni los casos que trabajó. |

Papeles: `socio` (administra y cierra), `abogado` (trabaja y cierra), `pasante`
(trabaja y redacta, no cierra ni borra), `administrativo` (ve y agenda, no
redacta). `puede(rol, permiso)` es puro y está probado; la UI debería pintar con
el bloque `puedo` que devuelve el GET, no re-implementar la tabla.

`POST /api/juridico/usuarios` (sólo operador) sigue existiendo para dar de alta
un despacho nuevo desde fuera; para sumar a alguien a un despacho existente, la
ruta es la del socio.

El chat y la subida de documentos responden **429 con `codigo: "JURIDICO_TOPE_MES"`** y el `consumo` cuando el asiento llegó a su tope (`JURIDICO_USD_MENSUAL`, **120 USD** por default). La UI debería enseñar el consumo en el pie y avisar al 80 %.

Medido con uso real (sept-2026): una abogada trabajando llega a ~37 USD al mes y
una jornada intensa de redacción a ~64. Con el tope en 60 se frenaba a quien
estaba trabajando bien. **El operador no tiene tope**: no es un asiento.

### El copiloto

Dos herramientas nuevas: `proponer_tareas` (nacen con `origen: "copiloto"` y
sin responsable — propone, no manda) y `consultar_tareas`. Cuando el copiloto
redacta o sube un documento, éste hereda el caso y queda apuntado en la
bitácora; al sobrescribir un borrador, la versión anterior se congela con autor
`copiloto` y el motivo del cambio.

Las rutas `/api/juridico/asuntos*` de hoy siguen funcionando.

## 5. Reglas que no cambian

- El mensaje del usuario se guarda al arrancar el turno; la respuesta al
  terminar. Un turno cortado deja `meta.error` en el mensaje del asistente.
- Un turno a la vez por conversación: **409 con `codigo: "TURNO_EN_CURSO"`**,
  aunque el turno corra en otro contenedor. La UI no debe enseñar ese 409 como
  error: hay que **engancharse** al turno que corre
  (`GET /api/juridico/chat?conversacionId=&desde=0`) y devolverle al usuario lo
  que escribió. Lo mismo al ABRIR una conversación: si hay un turno vivo, el GET
  lo reproduce desde el principio y se ve en vivo; si no hay ninguno, contesta
  204. Sin eso, recargar la pestaña a media respuesta deja la pantalla en blanco
  (pasó en producción el 14-sep-2026).
- Eventos SSE vigentes: `turno`, `conversation`, `text`, `tool_start`,
  `tool_done`, `documento`, `documento_progreso`, `asunto`, `replace`, `done`,
  `error`. Agregar uno es cambio de contrato: se anuncia aquí.
