import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { empresasAccesiblesIds } from "@/lib/authz";
import type { CsfPerfil } from "@/lib/fiscal/cumplimiento/types";

// GET /api/cumplimiento
// Panorama de cumplimiento por empresa accesible: la última opinión SAT (32-D),
// la última CSF (régimen, # obligaciones, CP, estatus del padrón) y los hallazgos
// de cumplimiento abiertos. Sólo lecturas baratas para que escale a muchos RFC.
// El PDF del acuse se descarga aparte vía /api/cumplimiento/acuse/[snapshotId].

export interface CumplimientoEmpresa {
  companyId: string;
  razonSocial: string;
  rfc: string;
  sat: {
    snapshotId: string;
    resultado: string; // POSITIVA | NEGATIVA | NO_LOCALIZADO | SIN_OBLIGACIONES | ERROR
    folio: string | null; // "Folio SAT: …" extraído de motivos
    motivos: string[];
    vigencia: string | null;
    fetchedAt: string;
    tieneAcuse: boolean;
  } | null;
  csf: {
    snapshotId: string;
    estatusPadron: string;
    regimenes: string[];
    obligacionesCount: number;
    codigoPostal: string | null;
    fetchedAt: string;
    tieneAcuse: boolean;
  } | null;
  hallazgos: {
    id: string;
    checkClave: string;
    severidad: string; // info | warn | error
    mensaje: string;
    sugerencia: string;
  }[];
}

const FOLIO_PREFIX = "Folio SAT:";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const ids = await empresasAccesiblesIds(session.user.id);
  if (ids.length === 0) return NextResponse.json({ empresas: [] });

  const [companies, snapshots, hallazgos] = await Promise.all([
    prisma.company.findMany({
      where: { id: { in: ids }, isActive: true },
      select: { id: true, rfc: true, razonSocial: true },
      orderBy: { razonSocial: "asc" },
    }),
    // Última snapshot por (empresa, tipo): orden desc + distinct toma la primera.
    prisma.complianceSnapshot.findMany({
      where: { companyId: { in: ids }, tipo: { in: ["SAT_OPINION", "CSF"] } },
      orderBy: [{ companyId: "asc" }, { tipo: "asc" }, { fetchedAt: "desc" }],
      distinct: ["companyId", "tipo"],
      select: {
        id: true, companyId: true, tipo: true, resultado: true, motivos: true,
        perfil: true, acuseUrl: true, vigencia: true, fetchedAt: true,
      },
    }),
    prisma.fiscalHallazgo.findMany({
      where: { companyId: { in: ids }, estado: "ABIERTO", checkClave: { startsWith: "cumplimiento." } },
      orderBy: { createdAt: "desc" },
      select: { id: true, companyId: true, checkClave: true, severidad: true, mensaje: true, sugerencia: true },
    }),
  ]);

  const satByCompany = new Map<string, (typeof snapshots)[number]>();
  const csfByCompany = new Map<string, (typeof snapshots)[number]>();
  for (const s of snapshots) {
    if (s.tipo === "SAT_OPINION" && !satByCompany.has(s.companyId)) satByCompany.set(s.companyId, s);
    if (s.tipo === "CSF" && !csfByCompany.has(s.companyId)) csfByCompany.set(s.companyId, s);
  }
  const hallazgosByCompany = new Map<string, CumplimientoEmpresa["hallazgos"]>();
  for (const h of hallazgos) {
    const arr = hallazgosByCompany.get(h.companyId) ?? [];
    arr.push({ id: h.id, checkClave: h.checkClave, severidad: h.severidad, mensaje: h.mensaje, sugerencia: h.sugerencia });
    hallazgosByCompany.set(h.companyId, arr);
  }

  const empresas: CumplimientoEmpresa[] = companies.map((c) => {
    const sat = satByCompany.get(c.id);
    const csf = csfByCompany.get(c.id);
    const perfil = (csf?.perfil ?? null) as CsfPerfil | null;
    return {
      companyId: c.id,
      razonSocial: c.razonSocial,
      rfc: c.rfc,
      sat: sat
        ? {
            snapshotId: sat.id,
            resultado: sat.resultado,
            folio: sat.motivos.find((m) => m.startsWith(FOLIO_PREFIX))?.slice(FOLIO_PREFIX.length).trim() ?? null,
            motivos: sat.motivos,
            vigencia: sat.vigencia ? sat.vigencia.toISOString() : null,
            fetchedAt: sat.fetchedAt.toISOString(),
            tieneAcuse: !!sat.acuseUrl,
          }
        : null,
      csf: csf
        ? {
            snapshotId: csf.id,
            estatusPadron: perfil?.estatusPadron ?? csf.resultado,
            regimenes: perfil?.regimenes ?? [],
            obligacionesCount: perfil?.obligaciones?.length ?? 0,
            codigoPostal: perfil?.codigoPostal ?? null,
            fetchedAt: csf.fetchedAt.toISOString(),
            tieneAcuse: !!csf.acuseUrl,
          }
        : null,
      hallazgos: hallazgosByCompany.get(c.id) ?? [],
    };
  });

  return NextResponse.json({ empresas });
}
