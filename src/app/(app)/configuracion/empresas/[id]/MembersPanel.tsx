"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, X, Copy, Check } from "lucide-react";

type Role = "OWNER" | "ADMIN" | "ACCOUNTANT" | "VIEWER";

type Member = {
  id: string;
  role: Role;
  user: { id: string; name: string | null; email: string };
};

const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Propietario",
  ADMIN: "Administrador",
  ACCOUNTANT: "Contador",
  VIEWER: "Solo lectura",
};

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  OWNER: "Acceso total, puede invitar miembros y eliminar la empresa",
  ADMIN: "Acceso total excepto eliminar empresa o transferir propiedad",
  ACCOUNTANT: "Sube FIEL/CSD, emite CFDIs, presenta declaraciones",
  VIEWER: "Solo puede ver, no modifica nada",
};

export function MembersPanel({
  companyId,
  isOwner,
  currentUserId,
  initialMembers,
}: {
  companyId: string;
  isOwner: boolean;
  currentUserId: string;
  initialMembers: Member[];
}) {
  const router = useRouter();
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("ACCOUNTANT");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setTempPassword(null);

    const res = await fetch(`/api/companies/${companyId}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: inviteEmail,
        name: inviteName || undefined,
        role: inviteRole,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "No se pudo invitar al usuario");
      setLoading(false);
      return;
    }

    setMembers((m) => [...m, { id: data.id, role: data.role, user: data.user }]);
    if (data.tempPassword) setTempPassword(data.tempPassword);
    setInviteEmail("");
    setInviteName("");
    setInviteRole("ACCOUNTANT");
    setLoading(false);
    if (!data.tempPassword) setShowInvite(false);
    router.refresh();
  }

  async function handleRoleChange(userId: string, newRole: Role) {
    const res = await fetch(`/api/companies/${companyId}/members/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.error ?? "Error");
      return;
    }
    setMembers((ms) => ms.map((m) => (m.user.id === userId ? { ...m, role: newRole } : m)));
  }

  async function handleRemove(userId: string, name: string) {
    if (!confirm(`¿Quitar a ${name} de esta empresa?`)) return;
    const res = await fetch(`/api/companies/${companyId}/members/${userId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error ?? "Error");
      return;
    }
    setMembers((ms) => ms.filter((m) => m.user.id !== userId));
    if (userId === currentUserId) router.push("/configuracion/empresas");
  }

  async function copyPassword() {
    if (!tempPassword) return;
    await navigator.clipboard.writeText(tempPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="bg-cos-card border border-cos-line rounded-xl overflow-hidden">
      {/* Members list */}
      <div className="divide-y divide-border">
        {members.map((m) => (
          <div key={m.id} className="px-5 py-3 flex items-center gap-4">
            <div className="h-9 w-9 rounded-full bg-cos-brand-tint text-cos-brand-ink flex items-center justify-center text-sm font-semibold shrink-0">
              {(m.user.name ?? m.user.email)[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm truncate">
                {m.user.name ?? m.user.email}
                {m.user.id === currentUserId && (
                  <span className="ml-2 text-xs text-cos-ink-soft">(tú)</span>
                )}
              </p>
              <p className="text-xs text-cos-ink-soft truncate">{m.user.email}</p>
            </div>
            {isOwner ? (
              <select
                value={m.role}
                onChange={(e) => handleRoleChange(m.user.id, e.target.value as Role)}
                className="text-xs border border-cos-line rounded-md px-2 py-1 bg-cos-card"
              >
                {(["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"] as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-xs px-2 py-1 rounded bg-cos-slate-tint text-cos-ink-soft">
                {ROLE_LABELS[m.role]}
              </span>
            )}
            {isOwner && (
              <button
                onClick={() => handleRemove(m.user.id, m.user.name ?? m.user.email)}
                className="text-cos-ink-soft hover:text-cos-red-ink p-1"
                title="Quitar"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Invite */}
      {isOwner && (
        <div className="border-t border-cos-line bg-cos-paper">
          {!showInvite ? (
            <button
              onClick={() => setShowInvite(true)}
              className="w-full px-5 py-3 flex items-center gap-2 text-sm text-cos-brand-ink hover:bg-cos-paper/50 font-medium"
            >
              <Plus className="h-4 w-4" /> Invitar miembro
            </button>
          ) : (
            <form onSubmit={handleInvite} className="p-5 space-y-3">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-sm font-semibold">Invitar miembro</h3>
                <button
                  type="button"
                  onClick={() => {
                    setShowInvite(false);
                    setError("");
                    setTempPassword(null);
                  }}
                  className="text-cos-ink-soft hover:text-cos-ink"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Correo</label>
                  <input
                    type="email"
                    required
                    value={inviteEmail}
                    onChange={(e) => setInviteEmail(e.target.value)}
                    placeholder="kata@ejemplo.com"
                    className="w-full px-3 py-2 border border-cos-line rounded-md text-sm bg-cos-card"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Nombre</label>
                  <input
                    type="text"
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    placeholder="Kata Cordero"
                    className="w-full px-3 py-2 border border-cos-line rounded-md text-sm bg-cos-card"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium mb-1">Rol</label>
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value as Role)}
                  className="w-full px-3 py-2 border border-cos-line rounded-md text-sm bg-cos-card"
                >
                  {(["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"] as Role[]).map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-cos-ink-soft mt-1">{ROLE_DESCRIPTIONS[inviteRole]}</p>
              </div>

              {error && <p className="text-sm text-cos-red-ink">{error}</p>}

              {tempPassword && (
                <div className="bg-cos-brand-tint border border-cos-brand-ink/15 rounded-md p-3 text-sm">
                  <p className="font-medium text-cos-brand-ink mb-1">Cuenta creada</p>
                  <p className="text-cos-brand-ink text-xs mb-2">
                    Comparte estas credenciales con la persona invitada (por WhatsApp, etc.). No las verás de nuevo.
                  </p>
                  <div className="flex items-center gap-2 bg-cos-card border border-cos-brand-ink/15 rounded px-2 py-1.5 font-mono text-xs">
                    <span className="flex-1 truncate">{tempPassword}</span>
                    <button
                      type="button"
                      onClick={copyPassword}
                      className="text-cos-brand-ink hover:text-cos-brand-ink shrink-0"
                    >
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep disabled:opacity-50"
              >
                {loading ? "Invitando..." : "Invitar"}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
