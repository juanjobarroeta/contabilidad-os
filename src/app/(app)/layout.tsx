import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { CompanyProvider } from "@/components/layout/CompanyProvider";
import { ChatPanel } from "@/components/ai/ChatPanel";
import { TrialBanner } from "@/components/layout/TrialBanner";
import { getUserSubscriptionState } from "@/lib/subscription";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

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
