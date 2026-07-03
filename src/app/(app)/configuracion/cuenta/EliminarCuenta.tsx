"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";

type EmpresaBloqueante = { companyId: string; rfc: string; razonSocial: string };

/**
 * Zona de peligro de la cuenta personal — baja definitiva del usuario
 * (LFPDPPP, derecho de cancelación). Requiere escribir el correo exacto de
 * la cuenta + aceptar la casilla de irreversibilidad. Si el usuario es el
 * único propietario de alguna empresa, el API responde 409 con la lista y
 * aquí se muestra qué empresas debe dar de baja primero.
 */
export function EliminarCuenta({ email }: { email: string }) {
  const [abierto, setAbierto] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [entiendo, setEntiendo] = useState(false);
  const [eliminando, setEliminando] = useState(false);
  const [error, setError] = useState("");
  const [empresasBloqueantes, setEmpresasBloqueantes] = useState<EmpresaBloqueante[]>([]);

  const coincide = confirmEmail.trim().toLowerCase() === email.trim().toLowerCase();

  async function handleEliminar() {
    if (!coincide || !entiendo) return;
    setEliminando(true);
    setError("");
    setEmpresasBloqueantes([]);
    try {
      const res = await fetch("/api/me", { method: "DELETE" });
      if (res.status === 204) {
        // Cuenta eliminada — cerrar sesión y salir.
        await signOut({ callbackUrl: "/login" });
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && Array.isArray(data.empresas)) {
        setEmpresasBloqueantes(data.empresas);
      }
      throw new Error(data.error ?? "No se pudo eliminar la cuenta");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error inesperado");
      setEliminando(false);
    }
  }

  return (
    <section className="bg-cos-card border border-cos-red-ink/30 rounded-xl shadow-sm p-5 mt-5">
      <h2 className="font-semibold text-sm mb-2 flex items-center gap-2 text-cos-red-ink">
        <AlertTriangle className="h-4 w-4" />
        Zona de peligro
      </h2>
      <p className="text-xs text-cos-ink-soft mb-3">
        Eliminar tu cuenta borra de forma <strong>definitiva e irreversible</strong> tu usuario,
        tus membresías, tus notificaciones y tus conversaciones. Si eres el único propietario de
        alguna empresa, primero deberás darla de baja desde su configuración.
      </p>

      {!abierto ? (
        <button
          onClick={() => setAbierto(true)}
          className="flex items-center gap-2 border border-cos-red-ink/40 text-cos-red-ink px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-red-tint"
        >
          <Trash2 className="h-4 w-4" />
          Eliminar mi cuenta
        </button>
      ) : (
        <div className="border border-cos-red-ink/20 bg-cos-red-tint/40 rounded-lg p-4 space-y-3">
          <div>
            <label className="block text-xs font-medium mb-1">
              Escribe tu correo (<span className="font-mono">{email}</span>) para confirmar
            </label>
            <input
              type="email"
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
              placeholder={email}
              className="w-full px-3 py-2 border border-cos-line rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-cos-red-ink/30"
            />
          </div>
          <label className="flex items-start gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={entiendo}
              onChange={(e) => setEntiendo(e.target.checked)}
              className="mt-0.5"
            />
            <span>Entiendo que esta acción es irreversible.</span>
          </label>
          {error && <p className="text-xs text-cos-red-ink">{error}</p>}
          {empresasBloqueantes.length > 0 && (
            <ul className="text-xs text-cos-ink list-disc pl-5 space-y-0.5">
              {empresasBloqueantes.map((e) => (
                <li key={e.companyId}>
                  <span className="font-medium">{e.razonSocial}</span>{" "}
                  <span className="font-mono text-cos-ink-soft">({e.rfc})</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={handleEliminar}
              disabled={!coincide || !entiendo || eliminando}
              className="flex items-center gap-2 bg-cos-red-ink text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {eliminando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              {eliminando ? "Eliminando…" : "Eliminar mi cuenta definitivamente"}
            </button>
            <button
              onClick={() => {
                setAbierto(false);
                setConfirmEmail("");
                setEntiendo(false);
                setError("");
                setEmpresasBloqueantes([]);
              }}
              disabled={eliminando}
              className="px-4 py-2 rounded-md text-sm text-cos-ink-soft hover:text-cos-ink"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
