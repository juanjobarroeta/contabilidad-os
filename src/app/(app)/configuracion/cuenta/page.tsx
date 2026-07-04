import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ArrowLeft, UserCircle } from "lucide-react";
import { EliminarCuenta } from "./EliminarCuenta";
import { TokensApi } from "./TokensApi";

export default async function CuentaPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { name: true, email: true, createdAt: true },
  });

  return (
    <div className="p-6 max-w-3xl">
      <Link
        href="/configuracion"
        className="inline-flex items-center gap-1.5 text-sm text-cos-ink-soft hover:text-cos-ink mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Configuración
      </Link>

      <div className="mb-6">
        <h1 className="text-2xl font-bold">Mi cuenta</h1>
      </div>

      <div className="bg-cos-card border border-cos-line rounded-xl p-6">
        <div className="flex items-start gap-4">
          <div className="h-12 w-12 rounded-full bg-cos-brand-tint text-cos-brand-ink flex items-center justify-center shrink-0">
            <UserCircle className="h-6 w-6" />
          </div>
          <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <Field label="Nombre" value={user?.name ?? "—"} />
            <Field label="Correo" value={user?.email ?? "—"} />
            <Field
              label="Cuenta desde"
              value={user?.createdAt ? new Date(user.createdAt).toLocaleDateString("es-MX") : "—"}
            />
          </div>
        </div>
        <p className="text-xs text-cos-ink-soft mt-6">
          Edición de perfil y cambio de contraseña próximamente.
        </p>
      </div>

      {/* Accesos de API activos (tokens de satélites) con revocación */}
      <TokensApi />

      {/* Zona de peligro — baja definitiva de la cuenta (LFPDPPP) */}
      {user?.email && <EliminarCuenta email={user.email} />}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-cos-ink-soft">{label}</p>
      <p className="font-medium mt-0.5">{value}</p>
    </div>
  );
}
