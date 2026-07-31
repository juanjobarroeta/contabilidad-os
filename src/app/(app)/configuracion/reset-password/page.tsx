import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { esAdminPlataforma } from "@/lib/billing/admin-plataforma";
import { ResetPasswordAdminClient } from "./reset-client";

export const dynamic = "force-dynamic";

// Restablecimiento de contraseñas — SOLO admin de plataforma. Para cualquier
// otro usuario la ruta no existe (404, no revelamos el panel).
export default async function ResetPasswordAdminPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  if (!user?.email || !esAdminPlataforma(user.email)) notFound();

  return (
    <div className="p-6 max-w-3xl">
      <Link href="/configuracion" className="mb-4 inline-flex items-center gap-1.5 text-sm text-cos-ink-soft hover:text-cos-ink">
        <ArrowLeft className="h-4 w-4" /> Configuración
      </Link>
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Restablecer contraseñas</h1>
        <p className="mt-1 text-sm text-cos-ink-soft">
          Genera un enlace de un solo uso (30 minutos) para un usuario que no puede entrar y
          compárteselo por el canal que ya uses con él. Todavía no se envían correos automáticos.
        </p>
      </div>
      <ResetPasswordAdminClient />
    </div>
  );
}
