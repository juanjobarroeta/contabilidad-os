import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ArrowLeft, Users } from "lucide-react";

const ROLE_LABELS: Record<string, string> = {
  OWNER: "Propietario",
  ADMIN: "Administrador",
  ACCOUNTANT: "Contador",
  VIEWER: "Solo lectura",
};

export default async function UsuariosPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // Companies where the current user is OWNER or ADMIN — only those count
  // for "users you manage". For VIEWER/ACCOUNTANT memberships we don't show
  // co-members of someone else's company.
  const myAdminMemberships = await prisma.companyMember.findMany({
    where: {
      userId: session.user.id,
      role: { in: ["OWNER", "ADMIN"] },
    },
    select: { companyId: true },
  });
  const companyIds = myAdminMemberships.map((m) => m.companyId);

  const allMembers = await prisma.companyMember.findMany({
    where: { companyId: { in: companyIds } },
    include: {
      user: { select: { id: true, name: true, email: true } },
      company: { select: { id: true, razonSocial: true, rfc: true } },
    },
    orderBy: [{ user: { email: "asc" } }, { createdAt: "asc" }],
  });

  // Group by user
  const byUser = new Map<
    string,
    {
      user: { id: string; name: string | null; email: string };
      memberships: { companyId: string; razonSocial: string; rfc: string; role: string }[];
    }
  >();

  for (const m of allMembers) {
    const key = m.user.id;
    if (!byUser.has(key)) {
      byUser.set(key, { user: m.user, memberships: [] });
    }
    byUser.get(key)!.memberships.push({
      companyId: m.company.id,
      razonSocial: m.company.razonSocial,
      rfc: m.company.rfc,
      role: m.role,
    });
  }

  const users = Array.from(byUser.values());

  return (
    <div className="p-6 max-w-5xl">
      <Link
        href="/configuracion"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Configuración
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold">Usuarios</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Personas con acceso a alguna de tus empresas.
        </p>
      </div>

      {users.length === 0 ? (
        <div className="bg-white border border-dashed border-border rounded-xl p-12 text-center">
          <Users className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">
            No administras ninguna empresa todavía. Crea una desde{" "}
            <Link href="/configuracion/empresas" className="text-primary hover:underline">
              Empresas
            </Link>
            .
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {users.map((u) => (
            <div key={u.user.id} className="bg-white border border-border rounded-xl p-5">
              <div className="flex items-start gap-4 mb-3">
                <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center text-sm font-semibold shrink-0">
                  {(u.user.name ?? u.user.email)[0].toUpperCase()}
                </div>
                <div className="flex-1">
                  <p className="font-semibold">{u.user.name ?? u.user.email}</p>
                  <p className="text-xs text-muted-foreground">{u.user.email}</p>
                </div>
              </div>
              <div className="space-y-1.5 pl-14">
                {u.memberships.map((m) => (
                  <div key={m.companyId} className="flex items-center gap-3 text-sm">
                    <Link
                      href={`/configuracion/empresas/${m.companyId}`}
                      className="text-foreground hover:text-primary truncate flex-1"
                    >
                      {m.razonSocial}{" "}
                      <span className="text-xs text-muted-foreground font-mono">{m.rfc}</span>
                    </Link>
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-muted-foreground">
                      {ROLE_LABELS[m.role] ?? m.role}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
