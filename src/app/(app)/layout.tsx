import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/layout/Sidebar";
import { CompanyProvider } from "@/components/layout/CompanyProvider";
import { ChatPanel } from "@/components/ai/ChatPanel";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return (
    <CompanyProvider userId={session.user.id!}>
      <div className="flex h-screen bg-gray-50">
        <Sidebar user={session.user} />
        <main className="flex-1 overflow-auto">
          {children}
        </main>
        <ChatPanel />
      </div>
    </CompanyProvider>
  );
}
