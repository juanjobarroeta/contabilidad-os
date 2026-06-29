"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Plus,
  Loader2,
  Copy,
  Check,
  Trash2,
  AlertCircle,
  MailPlus,
} from "lucide-react";

type ClientRole = "VIEWER" | "ACCOUNTANT";
type Status = "PENDING" | "ACCEPTED" | "REVOKED";

interface Invitation {
  id: string;
  email: string;
  role: ClientRole;
  status: Status;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

const ROLE_LABELS: Record<ClientRole, string> = {
  VIEWER: "Solo lectura",
  ACCOUNTANT: "Captura y consulta",
};

const STATUS_LABELS: Record<Status, string> = {
  PENDING: "Pendiente",
  ACCEPTED: "Aceptada",
  REVOKED: "Revocada",
};

// Panel para que el administrador del despacho invite a un CLIENTE a acceder a
// ESTA empresa únicamente. El cliente recibe un enlace de un solo uso; al
// aceptarlo obtiene acceso exclusivo a esta empresa y nunca a las demás del
// despacho.
export function ClientInvitesPanel({ companyId }: { companyId: string }) {
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [error, setError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ClientRole>("VIEWER");
  const [submitting, setSubmitting] = useState(false);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/companies/${companyId}/invitations`);
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) {
        setError("No se pudieron cargar las invitaciones");
        return;
      }
      setInvites(await res.json());
    } catch {
      setError("No se pudieron cargar las invitaciones");
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setLastLink(null);
    try {
      const res = await fetch(`/api/companies/${companyId}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "No se pudo crear la invitación");
        return;
      }
      setLastLink(data.acceptUrl ?? null);
      setEmail("");
      setRole("VIEWER");
      load();
    } catch {
      setError("No se pudo crear la invitación");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!confirm("¿Revocar esta invitación? El enlace dejará de funcionar.")) return;
    const res = await fetch(`/api/companies/${companyId}/invitations/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error ?? "No se pudo revocar");
      return;
    }
    load();
  }

  async function copyLink() {
    if (!lastLink) return;
    await navigator.clipboard.writeText(lastLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // Si el usuario no es administrador del despacho dueño, no mostramos el panel.
  if (forbidden) return null;

  return (
    <section className="bg-cos-card border border-cos-line rounded-xl shadow-sm p-5 mb-5">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <MailPlus className="h-4 w-4 text-cos-brand-ink" />
          <h2 className="font-semibold text-sm">Invitar cliente</h2>
        </div>
        {!showForm && (
          <button
            onClick={() => {
              setShowForm(true);
              setLastLink(null);
              setError("");
            }}
            className="flex items-center gap-1.5 text-xs bg-cos-brand text-white px-3 py-1.5 rounded-md font-medium hover:bg-cos-brand-deep"
          >
            <Plus className="h-3.5 w-3.5" /> Nueva invitación
          </button>
        )}
      </div>
      <p className="text-xs text-cos-ink-soft mb-4">
        El cliente invitado tendrá acceso únicamente a esta empresa y podrá
        vincular su propio WhatsApp. No verá ninguna otra empresa del despacho.
      </p>

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="bg-cos-paper border border-cos-line rounded-lg p-4 mb-4 space-y-3"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">
                Correo del cliente
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="cliente@ejemplo.com"
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm bg-cos-card focus:outline-none focus:ring-2 focus:ring-cos-brand/30"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Permiso</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as ClientRole)}
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm bg-cos-card"
              >
                {(["VIEWER", "ACCOUNTANT"] as ClientRole[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {error && <p className="text-xs text-cos-red-ink">{error}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setError("");
              }}
              className="flex-1 border border-cos-line rounded-md py-2 text-sm"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="flex-1 bg-cos-brand text-white rounded-md py-2 text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Generar invitación
            </button>
          </div>
        </form>
      )}

      {lastLink && (
        <div className="bg-cos-jade-tint border border-cos-jade-ink/20 rounded-md p-3 mb-4 text-sm">
          <p className="font-medium text-cos-jade-ink mb-1">Invitación creada</p>
          <p className="text-xs text-cos-jade-ink mb-2">
            Comparte este enlace con tu cliente (por correo, WhatsApp, etc.).
            Caduca en 7 días y solo puede usarse una vez.
          </p>
          <div className="flex items-center gap-2 bg-cos-card border border-cos-jade-ink/20 rounded px-2 py-1.5 font-mono text-xs">
            <span className="flex-1 truncate">{lastLink}</span>
            <button
              type="button"
              onClick={copyLink}
              className="text-cos-jade-ink shrink-0"
              title="Copiar enlace"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-cos-ink-soft text-sm py-3">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
        </div>
      ) : invites.length === 0 ? (
        <p className="text-xs text-cos-ink-soft py-2">
          Aún no hay invitaciones para esta empresa.
        </p>
      ) : (
        <div className="border border-cos-line rounded-lg divide-y divide-border">
          {invites.map((inv) => (
            <div key={inv.id} className="px-4 py-3 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">{inv.email}</p>
                <p className="text-xs text-cos-ink-soft">
                  {ROLE_LABELS[inv.role]} ·{" "}
                  {inv.status === "PENDING"
                    ? `Caduca ${new Date(inv.expiresAt).toLocaleDateString("es-MX")}`
                    : STATUS_LABELS[inv.status]}
                </p>
              </div>
              <span
                className={`text-xs px-2 py-1 rounded ${
                  inv.status === "PENDING"
                    ? "bg-cos-amber-tint text-cos-amber-ink"
                    : inv.status === "ACCEPTED"
                      ? "bg-cos-jade-tint text-cos-jade-ink"
                      : "bg-cos-slate-tint text-cos-ink-soft"
                }`}
              >
                {STATUS_LABELS[inv.status]}
              </span>
              {inv.status === "PENDING" && (
                <button
                  onClick={() => handleRevoke(inv.id)}
                  className="text-cos-ink-soft hover:text-cos-red-ink p-1"
                  title="Revocar invitación"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {error && !showForm && (
        <p className="flex items-center gap-1.5 text-xs text-cos-red-ink mt-2">
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </p>
      )}
    </section>
  );
}
