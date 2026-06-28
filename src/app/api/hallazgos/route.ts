import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getEffectiveCompanyMembership } from "@/lib/authz";

// GET /api/hallazgos?companyId=xxx&estado=ABIERTO
// Hallazgos del auditor fiscal de una empresa (CFDI, deducciones, ISN, 69-B,
// cumplimiento). El ciclo de vida (ABIERTO/RESUELTO/IGNORADO) lo gestiona el
// contador vía PATCH /api/hallazgos/[id]; esas decisiones sobreviven a las
// re-corridas del auditor y, en el caso 69-B, reactivan deducciones en el motor.

// "POSPUESTO" es un filtro virtual: estado ABIERTO con posponerHasta en el futuro.
const FILTROS = ["ABIERTO", "POSPUESTO", "RESUELTO", "IGNORADO"] as const;

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
  posponerHasta: string | null;
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
  const filtro = estadoParam && (FILTROS as readonly string[]).includes(estadoParam) ? estadoParam : undefined;

  const now = new Date();
  const noPospuesto = { OR: [{ posponerHasta: null }, { posponerHasta: { lte: now } }] };
  const pospuesto = { estado: "ABIERTO", posponerHasta: { gt: now } };
  // El filtro ABIERTO oculta los pospuestos (reaparecen al vencer); POSPUESTO los muestra.
  const whereFiltro =
    filtro === "ABIERTO"
      ? { estado: "ABIERTO", ...noPospuesto }
      : filtro === "POSPUESTO"
        ? pospuesto
        : filtro
          ? { estado: filtro }
          : {};

  const rows = await prisma.fiscalHallazgo.findMany({
    where: { companyId, ...whereFiltro },
    orderBy: [{ severidad: "asc" }, { createdAt: "desc" }],
  });

  // Conteos para las pestañas. ABIERTO = activos (sin pospuestos); POSPUESTO aparte.
  const [counts, pospuestos] = await Promise.all([
    prisma.fiscalHallazgo.groupBy({ by: ["estado"], where: { companyId }, _count: { _all: true } }),
    prisma.fiscalHallazgo.count({ where: { companyId, ...pospuesto } }),
  ]);
  const resumen = { ABIERTO: 0, POSPUESTO: pospuestos, RESUELTO: 0, IGNORADO: 0 } as Record<string, number>;
  for (const c of counts) resumen[c.estado] = c._count._all;
  resumen.ABIERTO = Math.max(0, resumen.ABIERTO - pospuestos);

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
    posponerHasta: h.posponerHasta?.toISOString() ?? null,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  }));

  return NextResponse.json({ hallazgos, resumen });
}
