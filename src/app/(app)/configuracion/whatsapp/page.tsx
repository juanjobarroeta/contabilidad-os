import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { WhatsappLinkCard } from "@/components/whatsapp/WhatsappLinkCard";

export default async function WhatsappConfigPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  return (
    <div className="p-6 max-w-3xl">
      <Link
        href="/configuracion"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-cos-ink-soft hover:text-cos-ink"
      >
        <ArrowLeft className="h-4 w-4" /> Configuración
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold">WhatsApp</h1>
        <p className="mt-1 text-sm text-cos-ink-soft">
          Vincula tu número para consultar tu contabilidad con el asistente por
          WhatsApp.
        </p>
      </div>

      <WhatsappLinkCard />
    </div>
  );
}
