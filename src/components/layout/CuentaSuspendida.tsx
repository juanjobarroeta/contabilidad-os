import { Lock } from "lucide-react";

// Pantalla de servicio suspendido por falta de pago. Se muestra en lugar de la
// app cuando accesoSuspendido() es true (kill-switch encendido, no operador,
// suscripción no activa). Permite cerrar sesión y muestra el contacto de pago.
export function CuentaSuspendida() {
  return (
    <div className="grid min-h-screen place-items-center bg-cos-paper px-6">
      <div className="w-full max-w-md rounded-card border border-cos-line bg-white p-8 text-center shadow-card">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-cos-amber-tint text-cos-amber-ink">
          <Lock className="h-6 w-6" />
        </div>
        <h1 className="text-[20px] font-semibold text-cos-ink">Servicio suspendido</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-cos-ink-soft">
          Tu suscripción tiene un pago pendiente. Regulariza tu pago para reactivar el
          acceso a tus declaraciones, conciliación y asistente.
        </p>
        <p className="mt-3 text-[13px] text-cos-ink-faint">
          ¿Ya pagaste o tienes dudas? Escríbenos y lo reactivamos.
        </p>
        <div className="mt-6 flex flex-col gap-2">
          <a
            href="/api/auth/signout"
            className="rounded-control border border-cos-line px-4 py-2 text-[13.5px] font-semibold text-cos-ink hover:bg-cos-paper"
          >
            Cerrar sesión
          </a>
        </div>
      </div>
    </div>
  );
}
