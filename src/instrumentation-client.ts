// Sentry en el NAVEGADOR para el hub (Next ≥15.3 carga este archivo solo en el
// cliente). Hasta ahora el hub solo reportaba errores del servidor: todo lo que
// se rompía dentro de React —un render que truena, un handler de click, una
// promesa sin catch— no lo veía nadie.
//
// La DSN aquí DEBE ser NEXT_PUBLIC_ porque viaja al bundle del navegador. Eso
// es esperado y no es un secreto: una DSN solo permite ESCRIBIR eventos, no
// leer nada de la organización. Si te preocupa el abuso, ponle un rate limit a
// esa llave en Sentry (Settings → Client Keys) en vez de intentar esconderla.
import * as Sentry from "@sentry/nextjs";
import {
  IGNORED_ERRORS,
  scrubEvent,
  sentryEnvironment,
  sentryRelease,
  tracesSampleRate,
} from "./lib/sentry-shared";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  // Session Replay: apagado por omisión. Este producto muestra datos fiscales
  // en pantalla (RFCs, montos, declaraciones), así que se enciende a propósito
  // con NEXT_PUBLIC_SENTRY_REPLAY=1 y siempre con el texto enmascarado.
  const replayEnabled = process.env.NEXT_PUBLIC_SENTRY_REPLAY === "1";

  Sentry.init({
    dsn,
    environment: sentryEnvironment(),
    release: sentryRelease(),
    tracesSampleRate: tracesSampleRate(),
    // Sin PII: nada de IPs ni cuerpos de request por default.
    sendDefaultPii: false,
    ignoreErrors: IGNORED_ERRORS,
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
    integrations: [
      // Propaga los headers `sentry-trace` y `baggage` en fetch/XHR hacia el
      // propio hub. Es lo que hace que un error de React y la excepción del
      // API que lo provocó aparezcan en UNA sola traza.
      Sentry.browserTracingIntegration(),
      ...(replayEnabled
        ? [
            Sentry.replayIntegration({
              maskAllText: true,
              blockAllMedia: true,
            }),
          ]
        : []),
    ],
    // Solo grabar replay cuando hubo error (barato); nunca sesiones completas.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: replayEnabled ? 1.0 : 0,
    // A quién se le adjuntan los headers de traza. Mismo origen (el hub se
    // llama a sí mismo) más el dominio de producción.
    tracePropagationTargets: [
      /^\//,
      /^https:\/\/[^/]*\.up\.railway\.app/,
    ],
  });
}

// Instrumenta las navegaciones del App Router para que un error después de
// cambiar de página se atribuya a la ruta correcta y no a la anterior.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
