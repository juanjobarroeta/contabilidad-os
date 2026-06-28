import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { CompanyProvider } from "@/components/layout/CompanyProvider";
import { ChatPanel } from "@/components/ai/ChatPanel";
import { TrialBanner } from "@/components/layout/TrialBanner";
import { getUserSubscriptionState } from "@/lib/subscription";
import { accesoSuspendido } from "@/lib/billing/suspension";
import { CuentaSuspendida } from "@/components/layout/CuentaSuspendida";
import { isOperador } from "@/lib/authz";
import { InstallPrompt } from "@/components/pwa/InstallPrompt";
import { PushOptIn } from "@/components/pwa/PushOptIn";
import { prisma } from "@/lib/prisma";

/**
 * Decide where a logged-in user should land in contabilidad-os.
 *
 * Returns one of:
 *   • "allowed"          — the user can access the CONTABILIDAD module on at
 *                          least one company. That access comes from a direct
 *                          CompanyMember whose allowedModules is empty (full)
 *                          or contains CONTABILIDAD, or from any DespachoMember
 *                          (despacho access is always full, never restricted).
 *   • "needs_onboarding" — the user has NO memberships at all (a brand-new
 *                          account). Send them to /onboarding to create their
 *                          first company instead of a confusing dead-end.
 *   • "restricted"       — the user HAS memberships but none grant CONTABILIDAD
 *                          (e.g. a construction-only Bartiz account). Send them
 *                          to /acceso-restringido, which points at Bartiz.
 */
type ContabilidadAccess = "allowed" | "needs_onboarding" | "restricted";

async function evaluateContabilidadAccess(
  userId: string
): Promise<ContabilidadAccess> {
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
      return "allowed";
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
  if (despachoMember) return "allowed";

  // No CONTABILIDAD access. A user with zero company memberships is brand-new
  // (just signed up, no company yet) → route to onboarding. A user WITH
  // memberships that simply don't grant contabilidad is a satellite/
  // construction-only account → the Bartiz dead-end.
  if (direct.length === 0) return "needs_onboarding";
  return "restricted";
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const access = await evaluateContabilidadAccess(session.user.id!);
  if (access === "needs_onboarding") redirect("/onboarding");
  if (access === "restricted") redirect("/acceso-restringido");

  const subscription = await getUserSubscriptionState(session.user.id!);
  const esOperador = await isOperador(session.user.id!);

  // Suspensión por falta de pago (inerte hasta BILLING_SUSPENSION_ENABLED=true;
  // nunca aplica al operador). Reemplaza la app por la pantalla de suspensión.
  if (await accesoSuspendido(session.user.id!)) {
    return <CuentaSuspendida />;
  }

  return (
    <CompanyProvider userId={session.user.id!}>
      <div className="flex h-screen bg-cos-paper">
        <Sidebar user={session.user} esOperador={esOperador} />
        {/* pt-14 on mobile clears the fixed top bar; none on md+ */}
        <main className="flex-1 overflow-auto flex flex-col pt-14 md:pt-0">
          <TrialBanner state={subscription} />
          <div className="flex-1 overflow-auto">{children}</div>
        </main>
        <ChatPanel />
        <InstallPrompt />
        <PushOptIn />
      </div>
    </CompanyProvider>
  );
}
