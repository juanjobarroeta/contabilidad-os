import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ArrowLeft, Users, Briefcase } from "lucide-react";

const ROLE_LABELS: Record<string, string> = {
  OWNER: "Propietario",
  ADMIN: "Administrador",
  ACCOUNTANT: "Contador",
  VIEWER: "Solo lectura",
};

type AccessSource =
  | { kind: "despacho"; role: string }
  | { kind: "company"; companyId: string; razonSocial: string; rfc: string; role: string };

type UserRow = {
  user: { id: string; name: string | null; email: string };
  despachoRole: string | null;
  companies: { companyId: string; razonSocial: string; rfc: string; role: string }[];
};

export default async function UsuariosPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // Load the user's own despacho membership
  const myDespacho = await prisma.despachoMember.findFirst({
    where: { userId: session.user.id },
    select: { despachoId: true, role: true },
  });

  // Companies where the current user is OWNER or ADMIN directly
  const myAdminMemberships = await prisma.companyMember.findMany({
    where: { userId: session.user.id, role: { in: ["OWNER", "ADMIN"] } },
    select: { companyId: true },
  });

  // All the companies I care about = (direct admin) ∪ (despacho companies)
  const companyIdSet = new Set<string>(myAdminMemberships.map((m) => m.companyId));
  if (myDespacho) {
    const despachoCompanies = await prisma.company.findMany({
      where: { despachoId: myDespacho.despachoId },
      select: { id: true },
    });
    for (const c of despachoCompanies) companyIdSet.add(c.id);
  }
  const companyIds = Array.from(companyIdSet);

  // ── Collect all users with access ──────────────────────────────────────
  // a) Despacho members (if I'm in a despacho, list everyone else in it)
  // b) Direct CompanyMembers on any company I care about
  const [despachoMembers, directMembers] = await Promise.all([
    myDespacho
      ? prisma.despachoMember.findMany({
          where: { despachoId: myDespacho.despachoId },
          include: { user: { select: { id: true, name: true, email: true } } },
          orderBy: { createdAt: "asc" },
        })
      : Promise.resolve([]),
    prisma.companyMember.findMany({
      where: { companyId: { in: companyIds } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        company: { select: { id: true, razonSocial: true, rfc: true } },
      },
      orderBy: [{ user: { email: "asc" } }, { createdAt: "asc" }],
    }),
  ]);

  const byUser = new Map<string, UserRow>();

  // First pass: despacho members (they're the "canonical" team)
  for (const dm of despachoMembers) {
    byUser.set(dm.user.id, {
      user: dm.user,
      despachoRole: dm.role,
      companies: [],
    });
  }

  // Second pass: direct company members (may or may not overlap with despacho)
  for (const cm of directMembers) {
    let row = byUser.get(cm.user.id);
    if (!row) {
      row = { user: cm.user, despachoRole: null, companies: [] };
      byUser.set(cm.user.id, row);
    }
    // Avoid duplicates if the user is both despacho member AND direct member
    row.companies.push({
      companyId: cm.company.id,
      razonSocial: cm.company.razonSocial,
      rfc: cm.company.rfc,
      role: cm.role,
    });
  }

  const users = Array.from(byUser.values());
  const hasDespacho = !!myDespacho;

  return (
    <div className="p-6 max-w-5xl">
      <Link
        href="/configuracion"
        className="inline-flex items-center gap-1.5 text-sm text-cos-ink-soft hover:text-cos-ink mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Configuración
      </Link>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Usuarios</h1>
          <p className="text-sm text-cos-ink-soft mt-1">
            Personas con acceso a tus empresas vía despacho o invitación directa.
          </p>
        </div>
        {hasDespacho && (
          <Link
            href="/configuracion/despacho"
            className="flex items-center gap-1.5 text-xs bg-cos-brand text-white px-3 py-1.5 rounded-md font-medium hover:bg-cos-brand-deep"
          >
            <Briefcase className="h-3.5 w-3.5" /> Administrar despacho
          </Link>
        )}
      </div>

      {users.length === 0 ? (
        <div className="bg-cos-card border border-dashed border-cos-line rounded-xl p-12 text-center">
          <Users className="h-10 w-10 text-cos-ink-soft mx-auto mb-3" />
          <p className="text-sm text-cos-ink-soft">
            Aún no hay otros miembros. Invita a alguien desde{" "}
            <Link href="/configuracion/despacho" className="text-cos-brand-ink hover:underline">
              Despacho
            </Link>
            .
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {users.map((u) => (
            <div key={u.user.id} className="bg-cos-card border border-cos-line rounded-xl p-5">
              <div className="flex items-start gap-4 mb-3">
                <div className="h-10 w-10 rounded-full bg-cos-brand-tint text-cos-brand-ink flex items-center justify-center text-sm font-semibold shrink-0">
                  {(u.user.name ?? u.user.email)[0].toUpperCase()}
                </div>
                <div className="flex-1">
                  <p className="font-semibold">{u.user.name ?? u.user.email}</p>
                  <p className="text-xs text-cos-ink-soft">{u.user.email}</p>
                </div>
                {u.despachoRole && (
                  <span className="text-xs px-2 py-1 rounded-full bg-cos-brand-tint text-cos-brand-ink font-medium flex items-center gap-1">
                    <Briefcase className="h-3 w-3" />
                    Despacho: {ROLE_LABELS[u.despachoRole] ?? u.despachoRole}
                  </span>
                )}
              </div>
              {u.companies.length > 0 ? (
                <div className="space-y-1.5 pl-14">
                  <p className="text-[10px] uppercase tracking-wide text-cos-ink-soft mb-1">Acceso directo</p>
                  {u.companies.map((m) => (
                    <div key={m.companyId} className="flex items-center gap-3 text-sm">
                      <Link
                        href={`/configuracion/empresas/${m.companyId}`}
                        className="text-cos-ink hover:text-cos-brand-ink truncate flex-1"
                      >
                        {m.razonSocial}{" "}
                        <span className="text-xs text-cos-ink-soft font-mono">{m.rfc}</span>
                      </Link>
                      <span className="text-xs px-2 py-0.5 rounded bg-cos-slate-tint text-cos-ink-soft">
                        {ROLE_LABELS[m.role] ?? m.role}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                u.despachoRole && (
                  <p className="pl-14 text-xs text-cos-ink-soft">
                    Ve todas las empresas del despacho.
                  </p>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
