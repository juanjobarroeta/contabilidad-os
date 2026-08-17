# Sentry: monitoreo entre proyectos y mantenimiento automático

Cómo está montado el monitoreo de errores del hub (`contabilidad-os`) y de sus
satélites, y cómo funciona el ciclo que convierte un error de producción en un
Pull Request sin que nadie lo pida.

Organización en Sentry: **`cumplo-id`** (región US).

---

## 1. Por qué un solo montaje y no uno por repo

El hub y sus satélites no son productos independientes: son **un sistema
partido por una frontera de red**. El satélite Automotriz no tiene base de
datos ni lógica contable — todo lo resuelve llamando al hub. Cuando un vendedor
ve "algo se rompió" en la pantalla de Inventario, la causa casi siempre está en
`contabilidad-os`, no en el SPA.

Si cada repo reporta a Sentry por su lado, el resultado son dos listas de
errores sin relación y un humano cruzándolas a mano por timestamp. Lo que une
las dos puntas es el **tracing distribuido**:

```
Navegador (Automotriz)                    Hub (contabilidad-os)
──────────────────────                    ─────────────────────
click en "Recibir unidad"
  └─ fetch POST /api/automotriz/...
       headers: sentry-trace, baggage ───────►  middleware (CORS los deja pasar)
                                                  └─ route handler
                                                       └─ 💥 excepción
                                                            │
       ambos eventos comparten trace_id ◄───────────────────┘
```

En Sentry esto se ve como **un solo hilo**: el error del navegador y la
excepción del servidor, con el stack completo de las dos capas.

### La pieza frágil

Los headers `sentry-trace` y `baggage` viajan **cross-origin**. El navegador
solo los manda si el preflight CORS los permite explícitamente. Por eso
`src/middleware.ts` los incluye en `Access-Control-Allow-Headers`:

```ts
"Authorization, Content-Type, sentry-trace, baggage"
```

**Si alguien quita esos dos nombres, no se rompe nada visible**: los errores
siguen llegando a Sentry, solo que desconectados. Es el modo de falla más caro
de este montaje porque es silencioso. Si en Sentry dejas de ver trazas que
cruzan de un proyecto al otro, revisa esa línea primero.

---

## 2. Qué está instrumentado

### `contabilidad-os` (Next.js 15, Railway)

Un solo SDK, `@sentry/nextjs`, cubriendo los tres runtimes:

| Runtime | Archivo | Qué captura |
|---|---|---|
| Node | `src/instrumentation.ts` → `src/lib/observability.ts` | rutas de API, server components, server actions, crons en proceso |
| Edge | `src/instrumentation.ts` (rama `NEXT_RUNTIME === "edge"`) | `src/middleware.ts` — el que decide auth y CORS |
| Navegador | `src/instrumentation-client.ts` | errores de React, handlers, promesas sin catch |
| Render raíz | `src/app/global-error.tsx` | el fallo que deja la pantalla en blanco |

Configuración compartida por los tres: `src/lib/sentry-shared.ts` (ambiente,
release, muestreo, filtrado de datos sensibles).

> **Nota histórica**: antes esto era `@sentry/node`, que solo veía el servidor.
> El navegador y el middleware corrían a ciegas. Los dos paquetes no pueden
> convivir (dos copias del SDK se pisan entre sí), por eso `@sentry/node` se
> quitó de `package.json` — `@sentry/nextjs` ya lo trae dentro con la versión
> exacta que le corresponde.

### `Automotriz` (React + Vite)

`@sentry/react` inicializado en `src/sentry.js`, montado desde `src/main.jsx`
**antes** de renderizar (para que un fallo en el primer render también cuente),
con una `Sentry.ErrorBoundary` en `src/App.jsx`.

---

## 3. Variables de entorno

### Hub (Railway → `contabilidad-os`)

| Variable | Dónde | Sin ella |
|---|---|---|
| `SENTRY_DSN` | runtime | el servidor no reporta (no-op silencioso) |
| `NEXT_PUBLIC_SENTRY_DSN` | runtime + build | el **navegador** no reporta |
| `SENTRY_AUTH_TOKEN` | **build** | los stack traces de producción quedan minificados |
| `SENTRY_ORG` / `SENTRY_PROJECT` | build | default `cumplo-id` / `contabilidad-os` |
| `SENTRY_TRACES_SAMPLE_RATE` | runtime | default `0.1` en prod, `0` en dev |
| `NEXT_PUBLIC_SENTRY_REPLAY` | runtime | Session Replay apagado |

`SENTRY_DSN` y `NEXT_PUBLIC_SENTRY_DSN` llevan **el mismo valor**. Una DSN solo
permite *escribir* eventos, nunca leer nada de la organización, así que
exponerla en el bundle del navegador es lo normal y no es una fuga. Si te
preocupa el abuso, ponle rate limit a la llave en Sentry → Settings → Client
Keys.

`env-check.ts` avisa al arranque si `SENTRY_DSN` está puesta pero
`NEXT_PUBLIC_SENTRY_DSN` no: la instrumentación a medias es peor que ninguna,
porque el silencio del navegador se lee como "no hay errores".

### Satélite (Railway → `Automotriz`)

`VITE_SENTRY_DSN`, `VITE_SENTRY_TRACES_SAMPLE_RATE`, `VITE_SENTRY_ENVIRONMENT`,
`VITE_SENTRY_REPLAY`, y `SENTRY_AUTH_TOKEN` en el build. Vite **hornea** las
`VITE_*` en el bundle: cambiarlas exige redeploy, no basta reiniciar.

---

## 4. Datos sensibles

Este producto maneja e.firma, CSD, contraseñas del SAT y RFCs. Nada de eso
puede salir hacia Sentry, así que hay tres capas:

1. **`sendDefaultPii: false`** en los tres runtimes — Sentry no adjunta IPs,
   cookies ni cuerpos de request por su cuenta.
2. **`scrubEvent`** (`src/lib/sentry-shared.ts`, y su gemelo en
   `Automotriz/src/sentry.js`): recorre cada evento antes de enviarlo y
   reemplaza por `[Filtrado]` el valor de toda clave cuyo nombre contenga
   `password`, `secret`, `token`, `authorization`, `csd`, `fiel`, `efirma`,
   `credential`… La lista está en `SENSITIVE_KEY_PATTERNS`; **ampliarla es más
   barato que una fuga**.
3. **Session Replay apagado por omisión**, y con `maskAllText` cuando se
   enciende.

Aun con esto: no metas secretos en el `context` de `reportError`.

---

## 5. Reportar errores a mano

`onRequestError` solo ve lo que **truena**. Un cron que atrapa su error, lo
guarda en un array y sigue, es invisible para Sentry. Para eso está
`reportError`:

```ts
import { reportError, withJobReporting } from "@/lib/observability";

// Puntual
reportError(err, { companyId, periodo }, { fingerprint: ["sat-sync", "descarga"] });

// Envolviendo un job entero (etiqueta y re-lanza)
await withJobReporting("sat-sync", () => syncSat(companyId), { companyId });
```

En scripts de `scripts/` que terminan con `process.exit`, llama
`await flushObservability()` antes de salir o los eventos se pierden en la cola.

> **Pendiente conocido**: hoy `reportError` está definido pero **no se llama
> desde ningún pipeline**. Los errores por-empresa que acumulan los crons
> (`errors[]`) siguen muriendo en logs efímeros. Es el siguiente lugar obvio
> donde ganar visibilidad.

---

## 6. El ciclo de mantenimiento automático

La rutina `sentry-triage` corre cada 4 horas en una sesión nueva de Claude Code
y hace esto:

1. Lee de Sentry los *issues* nuevos sin resolver de los dos proyectos.
2. Descarta ruido conocido y lo que ya tiene PR abierto.
3. Para cada issue real: lee el stack trace, lo cruza contra el código, y
   decide si puede arreglarlo con confianza.
4. Si sí → rama, fix, **PR en draft** (nunca push a `main`), y comenta el link
   del PR en el issue de Sentry.
5. Si no (ambiguo, o el arreglo es una decisión de producto) → lo deja y lo
   reporta en el resumen.
6. Notifica por push/email con lo que hizo.

La rutina `sentry-checkup` corre los lunes y mira lo que la triage no ve: qué
errores se repiten sin que nadie los toque, qué se disparó desde el último
deploy, dependencias con CVE, y `ignoreErrors` que estén tapando algo real.

**Reglas que las dos respetan** (viven en el prompt de cada rutina):

- PRs siempre en **draft** — nada se mergea solo.
- Nunca tocar migraciones de Prisma ya aplicadas, ni `prisma/migrations/`.
- Nunca "arreglar" un test borrándolo, saltándolo o relajando su aserción.
- Un PR por issue, con el link al issue de Sentry en el cuerpo.
- Si el arreglo toca cobro, cálculo fiscal o timbrado: **no lo hace**, lo
  escala en el resumen. Un error de IVA mal "arreglado" es peor que el error.

Para pausarlas, cambiarles el horario o apagarlas: son *Routines* de la cuenta,
se administran desde Claude Code (`list_triggers` / `update_trigger`).

---

## 7. Pendiente manual (requiere OAuth en la UI de Sentry)

Estas dos cosas no se pueden configurar por API y valen mucho:

1. **Integración con GitHub** (Sentry → Settings → Integrations → GitHub):
   conecta `juanjobarroeta/contabilidad-os` y `juanjobarroeta/automotriz`. Con
   ella, Sentry enlaza cada línea del stack trace al código en GitHub y marca
   *suspect commits* — o sea, señala el commit que probablemente introdujo el
   error. Eso hace el triage automático notablemente más certero.
2. **Alertas**: una regla por proyecto para issues nuevos con `level:error` en
   `environment:production`. Sin esto dependes del ciclo de 4 horas para
   enterarte de algo urgente.
