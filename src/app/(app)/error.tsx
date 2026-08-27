"use client";

// Error boundary del área de la app: un crash de render en una pantalla se
// degrada a este panel (con el nav intacto) en vez del global-error gris de
// página completa. Sentry lo captura explícitamente — los errores de
// renderizado atrapados por boundaries no siempre llegan solos.

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { Alert, RetryButton } from "@/components/ui/feedback";

export default function AppError({
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
    <div className="mx-auto mt-16 max-w-lg px-4">
      <Alert tone="danger" action={<RetryButton onClick={reset} label="Recargar" />}>
        Algo falló al mostrar esta pantalla. Tus datos están intactos — vuelve a
        intentarlo, y si persiste, avísanos.
      </Alert>
    </div>
  );
}
