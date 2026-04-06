import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ArrowLeft, Building2 } from "lucide-react";
import { MembersPanel } from "./MembersPanel";

export default async function EmpresaDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;

  const membership = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: session.user.id, companyId: id } },
    include: {
      company: {
        select: {
          id: true,
          rfc: true,
          razonSocial: true,
          regimenFiscal: true,
          codigoPostal: true,
          nombreComercial: true,
          email: true,
          telefono: true,
          isActive: true,
        },
      },
    },
  });

  if (!membership) notFound();

  const members = await prisma.companyMember.findMany({
    where: { companyId: id },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });

  const company = membership.company;
  const isOwner = membership.role === "OWNER";

  return (
    <div className="p-6 max-w-5xl">
      <Link
        href="/configuracion/empresas"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Empresas
      </Link>

      <div className="flex items-start gap-4 mb-8">
        <div className="h-12 w-12 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Building2 className="h-6 w-6" />
        </div>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">{company.razonSocial}</h1>
          <p className="text-sm text-muted-foreground font-mono mt-0.5">
            {company.rfc} · Régimen {company.regimenFiscal} · CP {company.codigoPostal}
          </p>
        </div>
      </div>

      <section className="mb-8">
        <h2 className="text-lg font-semibold mb-3">Datos generales</h2>
        <div className="bg-white border border-border rounded-xl p-5 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <Field label="Nombre comercial" value={company.nombreComercial} />
          <Field label="Correo" value={company.email} />
          <Field label="Teléfono" value={company.telefono} />
          <Field label="Estado" value={company.isActive ? "Activa" : "Inactiva"} />
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Miembros</h2>
        <MembersPanel
          companyId={company.id}
          isOwner={isOwner}
          currentUserId={session.user.id}
          initialMembers={members.map((m) => ({
            id: m.id,
            role: m.role,
            user: m.user,
          }))}
        />
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="font-medium mt-0.5">{value || "—"}</p>
    </div>
  );
}
