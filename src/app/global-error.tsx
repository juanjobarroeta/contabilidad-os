"use client";

// Frontera de error RAÍZ del App Router. Next la usa cuando el fallo ocurre en
// el layout raíz mismo, es decir, cuando ni siquiera hay app que mostrar: sin
// este archivo el usuario ve la pantalla en blanco del navegador y nosotros no
// nos enteramos nunca.
//
// Ojo: reemplaza al layout raíz, así que tiene que traer sus propios <html> y
// <body> y no puede apoyarse en los providers, las fuentes ni los estilos
// globales. Por eso los estilos van en línea.
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="es">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#f8fafc",
          color: "#0f172a",
        }}
      >
        <main style={{ maxWidth: "32rem", textAlign: "center" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600, margin: "0 0 .5rem" }}>
            Algo se rompió de nuestro lado
          </h1>
          <p style={{ margin: "0 0 1.5rem", color: "#475569", lineHeight: 1.6 }}>
            El error ya quedó registrado y lo estamos revisando. Ninguna
            información que hayas guardado se perdió.
          </p>
          <button
            onClick={() => reset()}
            style={{
              border: 0,
              borderRadius: ".5rem",
              padding: ".625rem 1.25rem",
              background: "#2563EB",
              color: "#fff",
              fontSize: ".9375rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Reintentar
          </button>
          {error.digest ? (
            <p style={{ marginTop: "1.5rem", fontSize: ".75rem", color: "#94a3b8" }}>
              Referencia: {error.digest}
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
