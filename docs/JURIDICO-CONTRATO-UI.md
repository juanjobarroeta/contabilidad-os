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

**Límite, dicho por delante.** Sólo se marcan las citas con **forma** de cita:
«artículo 486 del CPF», «regla 2.7.1.32 RMF», «reg. 2021760». Una cita en prosa
—«el Código de Procedimientos Familiares de Chihuahua»— no genera marca y no
aparece en `citas[]`. Pasa: el copiloto escribe así cuando el ordenamiento no
tiene siglas conocidas. La UI no debe asumir que `citas[]` cubre todo lo que el
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

## 4. Casos, clientes y bitácora (Fase 1)

Está planeado y todavía no escrito, así que la sesión de rediseño llega a tiempo
de opinar. El esquema que el hub va a proponer, en una frase cada uno:

- **`JuridicoCaso`** es el contenedor: título, materia, vía, autoridad,
  expediente, entidad, estado (`abierto` | `en_tramite` | `cerrado`), objetivo,
  responsable. Cuelgan de él conversaciones, documentos, partes, tareas y plazos.
  `JuridicoAsunto` de hoy se convierte en un caso con una conversación; nada se
  pierde.
- **`JuridicoCliente`** es el directorio del despacho: persona física o moral con
  RFC, CURP, domicilios, representantes y contactos, reutilizable entre casos.
  `JuridicoParte` pasa a ser el papel que un cliente (o un tercero) juega en un
  caso, no una captura suelta.
- **`JuridicoTarea`**: caso, título, responsable, vencimiento, prioridad, estado,
  y opcionalmente el documento o plazo del que nace.
- **Versiones con autor**: hoy `JuridicoDocumento.versiones` es un arreglo JSON
  sin autor. Pasa a tabla propia con `autorUserId`, `autorTipo`
  (`abogado` | `cliente` | `copiloto`), `motivo` y el diff por sección.
- **`JuridicoBitacora`**: append-only por caso — quién, cuándo, qué cambió
  (partes, tareas, documentos, accesos, comentarios del cliente). Es lo que
  alimenta W-09, y también la evidencia si un cliente discute qué se acordó.

Antes de escribir la migración, el hub publica aquí los modelos exactos. Si las
pantallas W-06 y W-09 necesitan un campo que no esté, es el momento de pedirlo.

## 5. Reglas que no cambian

- El mensaje del usuario se guarda al arrancar el turno; la respuesta al
  terminar. Un turno cortado deja `meta.error` en el mensaje del asistente.
- Un turno a la vez por conversación (409 si ya hay otro, aunque corra en otro
  contenedor).
- Eventos SSE vigentes: `turno`, `conversation`, `text`, `tool_start`,
  `tool_done`, `documento`, `documento_progreso`, `asunto`, `replace`, `done`,
  `error`. Agregar uno es cambio de contrato: se anuncia aquí.
