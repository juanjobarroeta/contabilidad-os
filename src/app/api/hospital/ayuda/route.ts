/**
 * POST /api/hospital/ayuda { companyId, pregunta, pagina?, mascota?, historial?: [{ rol: "usuario"|"mascota", texto }] }
 *   → { id, respuesta, paginas: [llave], sinRespuesta, modelo }
 *
 * La mascota de ayuda del satélite (lib/hospital/ayuda): contesta cómo usar
 * HospitalOS con la guía y el perfil del usuario (páginas, permisos, rol,
 * puesto). Cualquier miembro puede preguntar, vea las páginas que vea. Cada
 * pregunta queda en HospAyudaPregunta para las FAQ; 429 con el tope de IA.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, errorZod } from "@/lib/hospital/http";
import { nombreUsuario } from "@/lib/hospital/util";
import { MAX_HISTORIAL, MAX_PREGUNTA, preguntarAyuda } from "@/lib/hospital/ayuda/ayuda";

export const maxDuration = 60;

const schema = z.object({
  companyId: z.string().min(1),
  pregunta: z.string().trim().min(1).max(MAX_PREGUNTA),
  pagina: z.string().trim().max(40).nullable().optional(),
  mascota: z.string().trim().max(16).nullable().optional(),
  historial: z
    .array(z.object({ rol: z.enum(["usuario", "mascota"]), texto: z.string().max(4000) }))
    .max(MAX_HISTORIAL * 2)
    .optional(),
});

export const POST = withHospital(async (req: Request) => {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorZod(parsed.error);
  const d = parsed.data;

  const { user, membership } = await requireMembership(d.companyId, undefined, req);
  await requireModule(d.companyId, "HOSPITAL", req);
  const member = await prisma.companyMember.findUnique({
    where: { userId_companyId: { userId: user.id, companyId: d.companyId } },
    select: { hospitalPaginas: true, hospitalPermisos: true, hospitalPuesto: { select: { nombre: true } } },
  });

  const r = await preguntarAyuda(prisma, {
    companyId: d.companyId,
    userId: user.id,
    userNombre: nombreUsuario(user),
    nombreMascota: d.mascota || "Mochi",
    pregunta: d.pregunta,
    pagina: d.pagina || null,
    historial: d.historial ?? [],
    perfil: {
      rol: membership.role,
      paginas: member?.hospitalPaginas ?? [],
      permisos: member?.hospitalPermisos ?? [],
      puesto: member?.hospitalPuesto?.nombre ?? null,
    },
  });

  bitacora(user, req, {
    companyId: d.companyId,
    accion: "hospital.ayuda.preguntar",
    entidad: "HospAyudaPregunta",
    entidadId: r.id,
    detalle: { pagina: d.pagina ?? null, modelo: r.modelo, sinRespuesta: r.sinRespuesta, caracteres: d.pregunta.length },
  });

  return NextResponse.json(r);
});
