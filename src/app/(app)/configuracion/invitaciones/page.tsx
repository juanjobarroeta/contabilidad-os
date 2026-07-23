import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { esAdminPlataforma } from "@/lib/billing/admin-plataforma";
import { InvitacionesClient } from "./invitaciones-client";

export const dynamic = "force-dynamic";

// Invitaciones de onboarding — SOLO admin de plataforma (PLATFORM_ADMIN_EMAILS).
// Para cualquier otro usuario la ruta no existe (404, no revelamos el panel).
export default async function InvitacionesPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  if (!user?.email || !esAdminPlataforma(user.email)) notFound();

  return (
    <div className="p-6 max-w-4xl">
      <Link href="/configuracion" className="mb-4 inline-flex items-center gap-1.5 text-sm text-cos-ink-soft hover:text-cos-ink">
        <ArrowLeft className="h-4 w-4" /> Configuración
      </Link>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Invitaciones de onboarding</h1>
        <p className="mt-1 text-sm text-cos-ink-soft">
          Genera un enlace (o código) para que un cliente nuevo se dé de alta por la web con las
          condiciones que definas: cortesía (sin cargo) y sincronización SAT (Syntage) incluida. Al
          aceptar, se crea su despacho con él como dueño.
        </p>
      </div>
      <InvitacionesClient />
    </div>
  );
}
