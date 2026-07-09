import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { esAdminPlataforma } from "@/lib/billing/admin-plataforma";
import { stripeConfigured } from "@/lib/billing/stripe";
import { CodigosClient } from "./codigos-client";

export const dynamic = "force-dynamic";

// Generador de códigos de descuento por negociación (sustituye al plan
// "Despacho" como precio a la medida). SOLO visible para el admin de
// plataforma (PLATFORM_ADMIN_EMAILS); para cualquier otro usuario la ruta
// no existe (404, no 403: no revelamos que hay un panel aquí).
export default async function CodigosPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  if (!user?.email || !esAdminPlataforma(user.email)) notFound();

  return (
    <div className="p-6 max-w-4xl">
      <Link
        href="/configuracion"
        className="inline-flex items-center gap-1.5 text-sm text-cos-ink-soft hover:text-cos-ink mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Configuración
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold">Códigos de descuento</h1>
        <p className="text-sm text-cos-ink-soft mt-1">
          Genera un código por cliente según el precio que negociaste. El cliente lo escribe en la
          pantalla de pago al contratar su plan (Básico o Profesional).
        </p>
      </div>

      <CodigosClient configurado={stripeConfigured()} />
    </div>
  );
}
