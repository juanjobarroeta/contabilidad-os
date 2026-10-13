/**
 * POST /api/hospital/ayuda { companyId, pregunta, pagina?, mascota?, historial?: [{ rol: "usuario"|"mascota", texto }],
 *                            elemento?: { tipo, titulo, etiquetas[] } }
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
import { crearReporte, descargasDeReporte, textoResumen } from "@/lib/facturas/reporte-servicio";
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
  /** Arrastrar la mascota sobre una tarjeta/indicador/sección: sólo sus rótulos. */
  elemento: z
    .object({
      tipo: z.string().trim().min(1).max(40),
      titulo: z.string().trim().max(120).nullable(),
      etiquetas: z.array(z.string().trim().min(1).max(80)).max(20),
    })
    .nullable()
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
    elemento: d.elemento ?? null,
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
    detalle: { pagina: d.pagina ?? null, elemento: d.elemento?.tipo ?? null, modelo: r.modelo, sinRespuesta: r.sinRespuesta, caracteres: d.pregunta.length },
  });

  // Un reporte de facturas: el modelo sólo puso los FILTROS; las cifras y los
  // archivos los arma el hub. Los enlaces van firmados (24 h) porque el
  // navegador de HospitalOS no manda su Bearer en un <a href>.
  const { reporte, ...resto } = r;
  if (reporte) {
    try {
      const rep = await crearReporte(prisma, { companyId: d.companyId, userId: user.id, origen: "hospital-ayuda", filtros: reporte });
      if (rep.estado === "SIN_PERMISO") return NextResponse.json({ ...resto, respuesta: rep.motivo, descargas: [] });
      if (rep.estado === "ACLARAR") {
        const lineas = [
          ...rep.ambiguas.map((a) => `«${a.termino}» coincide con varios: ${a.candidatos.map((c) => `${c.razonSocial} (${c.rfc})`).join("; ")}. ¿Cuál es?`),
          ...rep.noEncontradas.map((t) => `No encontré a «${t}» en el directorio. ¿Cómo aparece su razón social o cuál es su RFC?`),
        ];
        return NextResponse.json({ ...resto, respuesta: lineas.join("\n"), descargas: [] });
      }
      const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim() ?? req.headers.get("host");
      const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? "https";
      const base = host ? `${proto}://${host}` : new URL(req.url).origin;
      return NextResponse.json({ ...resto, respuesta: `${resto.respuesta}\n\n${textoResumen(rep)}`, descargas: descargasDeReporte(rep.id, { base, firmar: true }), reporteId: rep.id });
    } catch (e) {
      const motivo = e instanceof Error && !/prisma|Invalid.*invocation|SELECT /i.test(e.message) ? e.message : "No pude armar el reporte.";
      return NextResponse.json({ ...resto, respuesta: `No pude armar el reporte: ${motivo}`, descargas: [] });
    }
  }
  return NextResponse.json({ ...resto, descargas: [] });
});
