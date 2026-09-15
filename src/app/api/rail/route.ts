import { NextResponse } from "next/server";
import { requireMembership, withAuthz } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { armarRail } from "@/lib/rail/armar";
import { agruparParaRail, type HallazgoRail } from "@/lib/hallazgos/agrupar";
import { saludActual } from "@/lib/salud/snapshot";
import { solicitudesAbiertas } from "@/lib/solicitudes/registro";
import { esTipoSolicitud } from "@/lib/solicitudes/claves";
import { normalizarResumen } from "@/lib/contador/prompt";

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/rail?companyId=
//
// El rail v3: lo que hice, lo que necesito de ti, cómo vamos. Junta lo que
// dejó la pasada del contador, las solicitudes abiertas, la foto de salud y
// los hallazgos, y lo entrega ya ordenado — el criterio vive en `armarRail`,
// que es puro; aquí sólo se consulta.
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic";

/** El resumen de la pasada se guarda como texto; la estructura vive en refs y título. */
const RESUMEN_TIPO = "resumen_corrida";

export const GET = withAuthz(async (req: Request) => {
  const companyId = new URL(req.url).searchParams.get("companyId");
  if (!companyId) return NextResponse.json({ error: "companyId es requerido" }, { status: 400 });
  await requireMembership(companyId, undefined, req);

  const [ultima, solicitudes, salud, hallazgos] = await Promise.all([
    prisma.expedienteNota.findFirst({
      where: { companyId, tipo: RESUMEN_TIPO },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, cuerpo: true, titulo: true, datos: true },
    }),
    solicitudesAbiertas(companyId),
    saludActual(companyId),
    prisma.fiscalHallazgo.findMany({
      where: { companyId, estado: "ABIERTO", OR: [{ posponerHasta: null }, { posponerHasta: { lte: new Date() } }] },
      select: { id: true, checkClave: true, severidad: true, mensaje: true, sugerencia: true },
      take: 2000,
    }),
  ]);

  // `categoria` es el prefijo de la clave del check, igual que en /api/hallazgos:
  // no es columna, se deriva — y derivarla en dos sitios distintos sería la
  // forma de que el rail y la lista acabaran agrupando diferente.
  const paraRail: HallazgoRail[] = hallazgos.map((h) => ({
    ...h,
    categoria: h.checkClave.split(".")[0] || "otros",
  }));
  // Sin tope de grupos: el corte lo hace `armarRail`, y un grupo enorme que se
  // perdiera en el tope nunca llegaría a presentarse como revisión.
  const agrupado = agruparParaRail(paraRail, { maxGrupos: 50 });
  const ahora = Date.now();

  const rail = armarRail({
    // `datos` trae el resumen estructurado; `cuerpo` es su versión para leer.
    // Se vuelve a normalizar al salir de la base porque una fila vieja puede no
    // tenerlo, y porque el normalizador es el que decide qué renglón cuenta.
    renglones: normalizarResumen(ultima?.datos ?? null).renglones,
    ultimaPasada: ultima?.createdAt.toISOString() ?? null,
    solicitudes: solicitudes.map((s) => ({
      id: s.id,
      tipo: esTipoSolicitud(s.tipo) ? s.tipo : "aclaracion",
      motivo: s.motivo,
      periodo: s.periodo,
      dias: Math.floor((ahora - s.createdAt.getTime()) / 86_400_000),
    })),
    dimensiones: salud?.dimensiones ?? [],
    deltas: salud?.deltas ?? [],
    grupos: agrupado.grupos,
  });

  return NextResponse.json({
    ...rail,
    resumen: ultima ? { titulo: ultima.titulo, cuerpo: ultima.cuerpo, fecha: ultima.createdAt } : null,
    informativos: agrupado.informativos,
  });
});
