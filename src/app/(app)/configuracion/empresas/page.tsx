import Link from "next/link";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { Building2, Plus, ArrowLeft, ChevronRight } from "lucide-react";

export default async function EmpresasPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const memberships = await prisma.companyMember.findMany({
    where: { userId: session.user.id },
    include: {
      company: {
        select: {
          id: true,
          rfc: true,
          razonSocial: true,
          regimenFiscal: true,
          codigoPostal: true,
          isActive: true,
          _count: { select: { members: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return (
    <div className="p-6 max-w-5xl">
      <Link
        href="/configuracion"
        className="inline-flex items-center gap-1.5 text-sm text-cos-ink-soft hover:text-cos-ink mb-4"
      >
        <ArrowLeft className="h-4 w-4" /> Configuración
      </Link>

      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Empresas</h1>
          <p className="text-sm text-cos-ink-soft mt-1">
            {memberships.length} {memberships.length === 1 ? "empresa" : "empresas"}
          </p>
        </div>
        <Link
          href="/onboarding?from=empresas&returnTo=/configuracion/empresas"
          className="inline-flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep"
        >
          <Plus className="h-4 w-4" /> Nueva empresa
        </Link>
      </div>

      {memberships.length === 0 ? (
        <div className="bg-white border border-dashed border-cos-line rounded-xl p-12 text-center">
          <Building2 className="h-10 w-10 text-cos-ink-soft mx-auto mb-3" />
          <p className="text-sm text-cos-ink-soft mb-4">Aún no tienes empresas configuradas.</p>
          <Link
            href="/onboarding"
            className="inline-flex items-center gap-2 bg-cos-brand text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-cos-brand-deep"
          >
            <Plus className="h-4 w-4" /> Crear primera empresa
          </Link>
        </div>
      ) : (
        <div className="bg-white border border-cos-line rounded-xl divide-y divide-border overflow-hidden">
          {memberships.map((m) => (
            <Link
              key={m.company.id}
              href={`/configuracion/empresas/${m.company.id}`}
              className="flex items-center gap-4 px-5 py-4 hover:bg-cos-paper/50 transition-colors"
            >
              <div className="h-10 w-10 rounded-lg bg-cos-brand-tint text-cos-brand-ink flex items-center justify-center shrink-0">
                <Building2 className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold truncate">{m.company.razonSocial}</p>
                <p className="text-xs text-cos-ink-soft font-mono mt-0.5">
                  {m.company.rfc} · Régimen {m.company.regimenFiscal} · CP {m.company.codigoPostal}
                </p>
              </div>
              <div className="text-right text-xs text-cos-ink-soft">
                <p className="font-medium text-cos-ink">{m.role}</p>
                <p className="mt-0.5">
                  {m.company._count.members}{" "}
                  {m.company._count.members === 1 ? "miembro" : "miembros"}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 text-cos-ink-soft shrink-0" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
