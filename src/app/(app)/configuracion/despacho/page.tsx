"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Users, Plus, Trash2, X, Pencil, Copy, Check, Loader2, AlertCircle } from "lucide-react";

type Role = "OWNER" | "ADMIN" | "ACCOUNTANT";

interface Member {
  id: string;
  role: Role;
  user: { id: string; name: string | null; email: string };
}

interface Despacho {
  id: string;
  name: string;
  myRole: Role;
  _count?: { members: number; companies: number };
}

const ROLE_LABELS: Record<Role, string> = {
  OWNER: "Propietario",
  ADMIN: "Administrador",
  ACCOUNTANT: "Contador",
};

const ROLE_DESCRIPTIONS: Record<Role, string> = {
  OWNER: "Acceso total, puede administrar miembros y eliminar el despacho",
  ADMIN: "Acceso total excepto eliminar el despacho",
  ACCOUNTANT: "Ve todas las empresas del despacho, no gestiona usuarios",
};

export default function DespachoPage() {
  const [despacho, setDespacho] = useState<Despacho | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Rename
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");
  const [savingName, setSavingName] = useState(false);

  // Invite modal
  const [showInvite, setShowInvite] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [dRes, mRes] = await Promise.all([
        fetch("/api/despacho"),
        fetch("/api/despacho/members"),
      ]);
      if (dRes.ok) {
        const d = await dRes.json();
        setDespacho(d);
        setNewName(d.name);
      } else if (dRes.status === 404) {
        setDespacho(null);
      } else {
        setError("Error al cargar despacho");
      }
      if (mRes.ok) {
        setMembers(await mRes.json());
      }
    } catch {
      setError("Error al cargar");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const isAdminOrOwner = despacho?.myRole === "OWNER" || despacho?.myRole === "ADMIN";

  async function handleSaveName() {
    if (!newName.trim() || newName === despacho?.name) {
      setEditingName(false);
      return;
    }
    setSavingName(true);
    try {
      const res = await fetch("/api/despacho", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (res.ok) {
        setEditingName(false);
        load();
      } else {
        const d = await res.json();
        setError(d.error ?? "No se pudo guardar");
      }
    } finally {
      setSavingName(false);
    }
  }

  async function handleRoleChange(userId: string, role: Role) {
    const res = await fetch(`/api/despacho/members/${userId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      const d = await res.json();
      alert(d.error ?? "Error");
      return;
    }
    setMembers((ms) => ms.map((m) => (m.user.id === userId ? { ...m, role } : m)));
  }

  async function handleRemove(userId: string, name: string) {
    if (!confirm(`¿Quitar a ${name} del despacho?\n\nPerderá acceso a TODAS las empresas del despacho.`)) return;
    const res = await fetch(`/api/despacho/members/${userId}`, { method: "DELETE" });
    if (!res.ok) {
      const d = await res.json();
      alert(d.error ?? "Error");
      return;
    }
    setMembers((ms) => ms.filter((m) => m.user.id !== userId));
  }

  if (loading) {
    return (
      <div className="p-8 flex items-center gap-2 text-cos-ink-soft text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Cargando…
      </div>
    );
  }

  if (!despacho) {
    return (
      <div className="p-6 max-w-3xl">
        <Link href="/configuracion" className="inline-flex items-center gap-1.5 text-sm text-cos-ink-soft hover:text-cos-ink mb-4">
          <ArrowLeft className="h-4 w-4" /> Configuración
        </Link>
        <div className="bg-white border border-dashed border-cos-line rounded-xl p-12 text-center">
          <Users className="h-10 w-10 text-cos-ink-soft mx-auto mb-3" />
          <p className="text-sm text-cos-ink-soft">No perteneces a ningún despacho.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-3xl">
      <Link href="/configuracion" className="inline-flex items-center gap-1.5 text-sm text-cos-ink-soft hover:text-cos-ink mb-4">
        <ArrowLeft className="h-4 w-4" /> Configuración
      </Link>

      {error && (
        <div className="flex items-center gap-2 bg-cos-red-tint border border-cos-red-ink/20 text-cos-red-ink px-4 py-3 rounded-lg text-sm mb-4">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")}><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {/* Despacho header */}
      <div className="mb-6">
        {editingName ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
              className="text-2xl font-bold border border-cos-line rounded-md px-2 py-1 bg-white"
            />
            <button
              onClick={handleSaveName}
              disabled={savingName}
              className="text-xs bg-cos-brand text-white px-3 py-1.5 rounded-md font-medium disabled:opacity-50"
            >
              {savingName ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Guardar"}
            </button>
            <button
              onClick={() => { setEditingName(false); setNewName(despacho.name); }}
              className="text-xs px-3 py-1.5 rounded-md border border-cos-line"
            >
              Cancelar
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{despacho.name}</h1>
            {isAdminOrOwner && (
              <button
                onClick={() => setEditingName(true)}
                className="p-1.5 rounded-md hover:bg-cos-paper text-cos-ink-soft"
                title="Editar nombre"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
        <p className="text-sm text-cos-ink-soft mt-1">
          {despacho._count?.members ?? 0} miembro(s) · {despacho._count?.companies ?? 0} empresa(s)
        </p>
      </div>

      {/* Members */}
      <div className="bg-white border border-cos-line rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
          <h2 className="font-semibold text-sm">Miembros del despacho</h2>
          {isAdminOrOwner && (
            <button
              onClick={() => setShowInvite(true)}
              className="flex items-center gap-1.5 text-xs bg-cos-brand text-white px-3 py-1.5 rounded-md font-medium hover:bg-cos-brand-deep"
            >
              <Plus className="h-3.5 w-3.5" /> Invitar / Crear usuario
            </button>
          )}
        </div>

        <div className="divide-y divide-border">
          {members.map((m) => (
            <div key={m.id} className="px-5 py-3 flex items-center gap-4">
              <div className="h-9 w-9 rounded-full bg-cos-brand-tint text-cos-brand-ink flex items-center justify-center text-sm font-semibold shrink-0">
                {(m.user.name ?? m.user.email)[0].toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">{m.user.name ?? m.user.email}</p>
                <p className="text-xs text-cos-ink-soft truncate">{m.user.email}</p>
              </div>
              {isAdminOrOwner ? (
                <select
                  value={m.role}
                  onChange={(e) => handleRoleChange(m.user.id, e.target.value as Role)}
                  className="text-xs border border-cos-line rounded-md px-2 py-1 bg-white"
                >
                  {(["OWNER", "ADMIN", "ACCOUNTANT"] as Role[]).map((r) => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
              ) : (
                <span className="text-xs px-2 py-1 rounded bg-cos-slate-tint text-cos-ink-soft">
                  {ROLE_LABELS[m.role]}
                </span>
              )}
              {isAdminOrOwner && (
                <button
                  onClick={() => handleRemove(m.user.id, m.user.name ?? m.user.email)}
                  className="text-cos-ink-soft hover:text-destructive p-1"
                  title="Quitar del despacho"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onAdded={() => { setShowInvite(false); load(); }}
        />
      )}
    </div>
  );
}

// ── Invite modal ─────────────────────────────────────────────────────────────
function InviteModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("ACCOUNTANT");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setTempPassword(null);
    try {
      const res = await fetch("/api/despacho/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name: name || undefined, role }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Error");
        setLoading(false);
        return;
      }
      if (data.tempPassword) {
        setTempPassword(data.tempPassword);
      } else {
        onAdded();
      }
    } catch {
      setError("Error");
    } finally {
      setLoading(false);
    }
  }

  async function copyPassword() {
    if (!tempPassword) return;
    await navigator.clipboard.writeText(tempPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center pt-16 p-4 z-50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-cos-line flex items-center justify-between">
          <h2 className="font-semibold">Invitar miembro al despacho</h2>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>

        {tempPassword ? (
          <div className="p-5 space-y-4">
            <div className="bg-cos-jade-tint border border-cos-jade-ink/20 rounded-md p-3 text-sm text-cos-jade-ink">
              <p className="font-medium mb-1">✓ Usuario creado y agregado al despacho</p>
              <p className="text-xs">
                Comparte estas credenciales con la persona (por WhatsApp, etc.). No las verás de nuevo.
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Correo</label>
              <div className="font-mono text-sm bg-cos-paper border border-cos-line rounded-md px-3 py-2">{email}</div>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Contraseña temporal</label>
              <div className="flex items-center gap-2 bg-cos-paper border border-cos-line rounded-md px-3 py-2 font-mono text-sm">
                <span className="flex-1">{tempPassword}</span>
                <button type="button" onClick={copyPassword} className="text-cos-ink-soft hover:text-cos-ink">
                  {copied ? <Check className="h-4 w-4 text-cos-jade-ink" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <button
              onClick={onAdded}
              className="w-full bg-cos-brand text-white rounded-md py-2 text-sm font-medium hover:bg-cos-brand-deep"
            >
              Listo
            </button>
          </div>
        ) : (
          <form onSubmit={submit} className="p-5 space-y-4">
            <p className="text-xs text-cos-ink-soft">
              Si el correo ya existe en ContabilidadOS, se invita al usuario existente.
              Si no, se crea una cuenta nueva con contraseña temporal.
            </p>
            <div>
              <label className="block text-xs font-medium mb-1">Correo *</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm"
                placeholder="kata@ejemplo.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Nombre (opcional)</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm"
                placeholder="Kata Cordero"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Rol en el despacho</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                className="w-full px-3 py-2 border border-cos-line rounded-md text-sm bg-white"
              >
                {(["OWNER", "ADMIN", "ACCOUNTANT"] as Role[]).map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
              <p className="text-xs text-cos-ink-soft mt-1">{ROLE_DESCRIPTIONS[role]}</p>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={onClose} className="flex-1 border border-cos-line rounded-md py-2 text-sm">Cancelar</button>
              <button
                type="submit"
                disabled={loading}
                className="flex-1 bg-cos-brand text-white rounded-md py-2 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                Invitar / Crear
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
