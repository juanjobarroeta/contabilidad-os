import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// GET /api/hallazgos?companyId=xxx&estado=ABIERTO
// Hallazgos del auditor fiscal de una empresa (CFDI, deducciones, ISN, 69-B,
// cumplimiento). El ciclo de vida (ABIERTO/RESUELTO/IGNORADO) lo gestiona el
// contador vía PATCH /api/hallazgos/[id]; esas decisiones sobreviven a las
// re-corridas del auditor y, en el caso 69-B, reactivan deducciones en el motor.

const ESTADOS = ["ABIERTO", "RESUELTO", "IGNORADO"] as const;

export interface HallazgoDTO {
  id: string;
  checkClave: string;
  categoria: string; // prefijo antes del primer "." (efos, isn, cfdi, cumplimiento…)
  severidad: string; // info | warn | error
  mensaje: string;
  sugerencia: string;
  fundamento: { ley: string; articulo: string; fraccion: string | null };
  referencias: string[];
  estado: string;
  createdAt: string;
  updatedAt: string;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId requerido" }, { status: 400 });

  const member = await getEffectiveCompanyMembership(session.user.id, companyId);
  if (!member) return NextResponse.json({ error: "Sin acceso" }, { status: 403 });

  const estadoParam = searchParams.get("estado");
  const estado = estadoParam && (ESTADOS as readonly string[]).includes(estadoParam) ? estadoParam : undefined;

  const rows = await prisma.fiscalHallazgo.findMany({
    where: { companyId, ...(estado ? { estado } : {}) },
    orderBy: [{ severidad: "asc" }, { createdAt: "desc" }],
  });

  // Conteo por estado para las pestañas (independiente del filtro aplicado).
  const counts = await prisma.fiscalHallazgo.groupBy({
    by: ["estado"],
    where: { companyId },
    _count: { _all: true },
  });
  const resumen = { ABIERTO: 0, RESUELTO: 0, IGNORADO: 0 } as Record<string, number>;
  for (const c of counts) resumen[c.estado] = c._count._all;

  const hallazgos: HallazgoDTO[] = rows.map((h) => ({
    id: h.id,
    checkClave: h.checkClave,
    categoria: h.checkClave.split(".")[0] || "otros",
    severidad: h.severidad,
    mensaje: h.mensaje,
    sugerencia: h.sugerencia,
    fundamento: { ley: h.fundamentoLey, articulo: h.fundamentoArticulo, fraccion: h.fundamentoFraccion },
    referencias: h.referencias,
    estado: h.estado,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  }));

  return NextResponse.json({ hallazgos, resumen });
}
