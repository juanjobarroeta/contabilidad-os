import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { CompanyProvider } from "@/components/layout/CompanyProvider";
import { ChatPanel } from "@/components/ai/ChatPanel";
import { TrialBanner } from "@/components/layout/TrialBanner";
import { getUserSubscriptionState } from "@/lib/subscription";
import { prisma } from "@/lib/prisma";

/**
 * Gate the entire contabilidad-os web UI behind CONTABILIDAD access.
 *
 * A user is allowed in if they have at least one company where they can
 * access the CONTABILIDAD module. That access can come from:
 *   • A direct CompanyMember row whose allowedModules is empty (full
 *     access) or contains CONTABILIDAD
 *   • A DespachoMember row on the despacho that owns a company that has
 *     CONTABILIDAD enabled (despacho access is always full, never
 *     restricted — consistent with how `requireMembership` treats it)
 *
 * If none of those apply, the user is a satellite-only account (e.g. a
 * construction-only PM) and we redirect them to /acceso-restringido,
 * which points them at bartiz.vercel.app.
 *
 * Returns true = allowed, false = deny.
 */
async function userCanAccessContabilidad(userId: string): Promise<boolean> {
  // Direct memberships with access
  const direct = await prisma.companyMember.findMany({
    where: { userId },
    select: {
      allowedModules: true,
      company: {
        select: {
          isActive: true,
          modules: {
            where: { habilitado: true },
            select: { modulo: true },
          },
        },
      },
    },
  });

  for (const m of direct) {
    if (!m.company.isActive) continue;
    const enabled = m.company.modules.map((x) => x.modulo);
    if (!enabled.includes("CONTABILIDAD")) continue;
    const restricted =
      Array.isArray(m.allowedModules) && m.allowedModules.length > 0;
    if (!restricted || m.allowedModules.includes("CONTABILIDAD")) {
      return true;
    }
  }

  // Despacho access — any despacho membership grants contabilidad access.
  // A brand-new despacho with zero companies still needs to reach /onboarding
  // to add the first one; gating on "has at least one company" would lock
  // out new despacho owners.
  const despachoMember = await prisma.despachoMember.findFirst({
    where: { userId },
    select: { id: true },
  });
  if (despachoMember) return true;

  return false;
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const allowed = await userCanAccessContabilidad(session.user.id!);
  if (!allowed) redirect("/acceso-restringido");

  const subscription = await getUserSubscriptionState(session.user.id!);

  return (
    <CompanyProvider userId={session.user.id!}>
      <div className="flex h-screen bg-gray-50">
        <Sidebar user={session.user} />
        <main className="flex-1 overflow-auto flex flex-col">
          <TrialBanner state={subscription} />
          <div className="flex-1 overflow-auto">{children}</div>
        </main>
        <ChatPanel />
      </div>
    </CompanyProvider>
  );
}
