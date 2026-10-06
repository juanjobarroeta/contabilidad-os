/**
 * GET /api/hospital/ayuda/preguntas?companyId=&dias=30&filtro=todas|sin-respuesta|no-utiles
 *   → { resumen: { total, utiles, noUtiles, sinValorar, sinRespuesta },
 *       porPagina: [{ pagina, total, noUtiles, sinRespuesta }],
 *       repetidas: [{ pregunta, veces, ultima }],
 *       preguntas: [{ id, createdAt, userNombre, pagina, pregunta, respuesta, paginasSugeridas, sinRespuesta, util, comentario }] }
 *
 * El tablero de lo que el personal le pregunta a la mascota (sólo dueño/admin,
 * ver enforceHospitalAccess): qué no encuentran, qué no entienden y dónde la
 * guía o la pantalla se quedan cortas. Las repetidas son candidatas a FAQ.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { resumirPreguntas } from "@/lib/hospital/ayuda/tablero";

const LIMITE = 500;

export const GET = withHospital(async (req: Request) => {
  const q = new URL(req.url).searchParams;
  const companyId = q.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, ["OWNER", "ADMIN"], req);
  await requireModule(companyId, "HOSPITAL", req);

  const dias = Math.min(Math.max(Number(q.get("dias")) || 30, 1), 365);
  const filtro = q.get("filtro");
  const desde = new Date(Date.now() - dias * 86_400_000);

  const filas = await prisma.hospAyudaPregunta.findMany({
    where: { companyId, createdAt: { gte: desde } },
    orderBy: { createdAt: "desc" },
    take: LIMITE,
    select: {
      id: true, createdAt: true, userNombre: true, pagina: true, pregunta: true, respuesta: true,
      paginasSugeridas: true, sinRespuesta: true, util: true, comentario: true,
    },
  });

  const { resumen, porPagina, repetidas } = resumirPreguntas(filas);
  const preguntas =
    filtro === "sin-respuesta" ? filas.filter((f) => f.sinRespuesta)
    : filtro === "no-utiles" ? filas.filter((f) => f.util === false)
    : filas;

  return NextResponse.json({ dias, truncado: filas.length === LIMITE, resumen, porPagina, repetidas, preguntas });
});
