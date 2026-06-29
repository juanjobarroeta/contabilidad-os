"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { getSession } from "next-auth/react";
import Link from "next/link";
import { Loader2, CheckCircle2, AlertCircle, Building2 } from "lucide-react";

interface Preview {
  email: string;
  company: string;
  status: "PENDING" | "ACCEPTED" | "REVOKED";
  usable: boolean;
}

// Página pública de aceptación de invitación de cliente. El cliente llega aquí
// con el enlace que le compartió el despacho. Tras iniciar sesión (o registrarse)
// con el correo invitado, acepta y obtiene acceso EXCLUSIVO a esa empresa.
export default function AceptarInvitacionPage() {
  const { token } = useParams() as { token: string };
  const router = useRouter();

  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [accepting, setAccepting] = useState(false);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    getSession()
      .then((s) => setSessionEmail(s?.user?.email?.toLowerCase() ?? null))
      .catch(() => setSessionEmail(null))
      .finally(() => setSessionLoaded(true));
  }, []);

  const loadPreview = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/invitations/${token}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "La invitación no es válida");
        return;
      }
      setPreview(data);
    } catch {
      setError("No se pudo cargar la invitación");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  async function handleAccept() {
    setAccepting(true);
    setError("");
    try {
      const res = await fetch(`/api/invitations/${token}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "No se pudo aceptar la invitación");
        return;
      }
      setAccepted(true);
      setTimeout(() => router.push("/dashboard"), 1500);
    } catch {
      setError("No se pudo aceptar la invitación");
    } finally {
      setAccepting(false);
    }
  }

  const loggedIn = !!sessionEmail;
  const emailMatches =
    !!preview && !!sessionEmail && sessionEmail === preview.email.toLowerCase();

  const returnTo = encodeURIComponent(`/invitacion/${token}`);

  return (
    <div className="min-h-screen flex items-center justify-center bg-cos-paper p-4">
      <div className="w-full max-w-md bg-cos-card rounded-xl shadow-sm border border-cos-line p-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-cos-ink">ContabilidadOS</h1>
          <p className="text-cos-ink-soft text-sm mt-1">Invitación de acceso</p>
        </div>

        {loading || !sessionLoaded ? (
          <div className="flex items-center gap-2 text-cos-ink-soft text-sm py-6">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
          </div>
        ) : error && !preview ? (
          <div className="flex items-start gap-2 bg-cos-red-tint border border-cos-red-ink/20 text-cos-red-ink px-4 py-3 rounded-lg text-sm">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        ) : accepted ? (
          <div className="text-center py-6">
            <CheckCircle2 className="h-10 w-10 text-cos-jade-ink mx-auto mb-3" />
            <p className="text-sm font-medium">Acceso concedido</p>
            <p className="text-xs text-cos-ink-soft mt-1">
              Te estamos llevando a tu panel…
            </p>
          </div>
        ) : preview ? (
          <>
            <div className="bg-cos-paper border border-cos-line rounded-lg p-4 mb-5">
              <div className="flex items-center gap-2 mb-1">
                <Building2 className="h-4 w-4 text-cos-brand-ink" />
                <p className="font-semibold text-sm">{preview.company}</p>
              </div>
              <p className="text-xs text-cos-ink-soft">
                Invitación para <span className="font-medium">{preview.email}</span>
              </p>
            </div>

            {!preview.usable ? (
              <div className="flex items-start gap-2 bg-cos-red-tint border border-cos-red-ink/20 text-cos-red-ink px-4 py-3 rounded-lg text-sm">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  {preview.status === "REVOKED"
                    ? "Esta invitación fue revocada."
                    : preview.status === "ACCEPTED"
                      ? "Esta invitación ya fue aceptada."
                      : "Esta invitación expiró. Pide una nueva al despacho."}
                </span>
              </div>
            ) : !loggedIn ? (
              <div className="space-y-3">
                <p className="text-sm text-cos-ink-soft">
                  Inicia sesión o crea tu cuenta con el correo{" "}
                  <span className="font-medium">{preview.email}</span> para
                  aceptar la invitación.
                </p>
                <div className="flex gap-2">
                  <Link
                    href={`/login?callbackUrl=${returnTo}`}
                    className="flex-1 text-center border border-cos-line rounded-md py-2 text-sm font-medium hover:bg-cos-paper"
                  >
                    Iniciar sesión
                  </Link>
                  <Link
                    href={`/signup?email=${encodeURIComponent(preview.email)}&callbackUrl=${returnTo}`}
                    className="flex-1 text-center bg-cos-brand text-white rounded-md py-2 text-sm font-medium hover:bg-cos-brand-deep"
                  >
                    Crear cuenta
                  </Link>
                </div>
              </div>
            ) : !emailMatches ? (
              <div className="space-y-3">
                <div className="flex items-start gap-2 bg-cos-amber-tint border border-cos-amber-ink/20 text-cos-amber-ink px-4 py-3 rounded-lg text-sm">
                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                  <span>
                    Tienes la sesión iniciada como{" "}
                    <span className="font-medium">{sessionEmail}</span>, pero esta
                    invitación es para{" "}
                    <span className="font-medium">{preview.email}</span>.
                  </span>
                </div>
                <Link
                  href={`/login?callbackUrl=${returnTo}`}
                  className="block text-center border border-cos-line rounded-md py-2 text-sm font-medium hover:bg-cos-paper"
                >
                  Iniciar sesión con otro correo
                </Link>
              </div>
            ) : (
              <div className="space-y-3">
                {error && <p className="text-sm text-cos-red-ink">{error}</p>}
                <button
                  onClick={handleAccept}
                  disabled={accepting}
                  className="w-full bg-cos-brand text-white rounded-md py-2.5 text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {accepting && <Loader2 className="h-4 w-4 animate-spin" />}
                  Aceptar y acceder a {preview.company}
                </button>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}
