/**
 * GET /api/hospital/episodios/[id]/cda?companyId=&tipo=EPISODIO|EGRESO|REFERENCIA[&guardar=1]
 *     [&destinatarioNombre=&destinatarioCedula=&destinatarioClues=&destinatarioOrganizacion=&motivo=]
 *
 * CDA R2 «Resumen Clínico» del episodio (NOM-024-SSA3-2012 6.1.3.1,
 * GIIS-A001-01-05) como application/xml descargable. EGRESO sólo con alta
 * (409); REFERENCIA exige destinatario (400) y motivo (o nota de referencia).
 * `guardar=1` deja el XML en el expediente como HospDocumento RESUMEN_CLINICO
 * (pide rol de escritura). Siempre registra HospAcceso EXPORTACION.
 *
 * Cabeceras: X-CDA-Id (UUID del documento), X-CDA-Root (OID raíz del id),
 * X-CDA-Intercambiable true|false (false sin OID registrado o sin CLUES).
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, usuarioDe } from "@/lib/hospital/http";
import { registrarAcceso } from "@/lib/hospital/accesos";
import { claveDia } from "@/lib/hospital/tz";
import { TIPOS_RESUMEN, construirResumenClinico, type Destinatario, type TipoResumen } from "@/lib/hospital/cda/resumen-clinico";

type Ctx = { params: Promise<{ id: string }> };

const MAX_PARAM = 200;
const texto = (v: string | null): string | null => {
  const t = v?.trim();
  return t ? t.slice(0, MAX_PARAM) : null;
};

export const GET = withHospital(async (req: Request, ctx: Ctx) => {
  const { id } = await ctx.params;
  const { searchParams } = new URL(req.url);

  const ep = await prisma.hospEpisodio.findUnique({ where: { id }, select: { id: true, companyId: true, folio: true, pacienteId: true } });
  // Un companyId que no es el del episodio se trata como inexistente: no se revela que el folio existe en otra empresa.
  const companyId = texto(searchParams.get("companyId"));
  if (!ep || (companyId && companyId !== ep.companyId)) throw new AuthzError(404, "Episodio no encontrado");

  const guardar = searchParams.get("guardar") === "1" || searchParams.get("guardar") === "true";
  const { user } = guardar ? await requireWriter(ep.companyId, req) : await requireMembership(ep.companyId, undefined, req);
  await requireModule(ep.companyId, "HOSPITAL", req);

  const tipoParam = (texto(searchParams.get("tipo")) ?? "EPISODIO").toUpperCase() as TipoResumen;
  if (!TIPOS_RESUMEN.includes(tipoParam)) return error(`tipo inválido: ${tipoParam} (EPISODIO, EGRESO o REFERENCIA)`);

  const destinatarioNombre = texto(searchParams.get("destinatarioNombre"));
  const destinatario: Destinatario | null = destinatarioNombre
    ? {
        nombre: destinatarioNombre,
        cedula: texto(searchParams.get("destinatarioCedula")),
        clues: texto(searchParams.get("destinatarioClues")),
        organizacion: texto(searchParams.get("destinatarioOrganizacion")),
      }
    : null;
  const motivo = searchParams.get("motivo")?.trim().slice(0, 5000) || null;

  const ahora = new Date();
  const { xml, meta } = await construirResumenClinico(prisma, {
    companyId: ep.companyId,
    episodioId: ep.id,
    tipo: tipoParam,
    destinatario,
    motivo,
    usuario: { id: user.id, email: user.email, nombre: usuarioDe(user).nombre },
    ahora,
  });

  let documentoId: string | null = null;
  if (guardar) {
    const bytes = Buffer.from(xml, "utf8");
    const doc = await prisma.hospDocumento.create({
      data: {
        companyId: ep.companyId,
        pacienteId: ep.pacienteId,
        episodioId: ep.id,
        tipo: "RESUMEN_CLINICO",
        nombre: `Resumen clínico (${meta.tipo}) ${claveDia(ahora)}`,
        estado: "RECIBIDO",
        requerido: false,
        mime: "application/xml",
        bytes: bytes.length,
        archivo: new Uint8Array(bytes),
        subidoPorUserId: user.id,
        contenido: {
          tipo: meta.tipo,
          id: meta.id,
          oidRoot: meta.oidRoot,
          intercambiable: meta.intercambiable,
          hash: meta.hash,
          codigo: meta.codigo,
          advertencias: meta.advertencias,
        },
      },
      select: { id: true },
    });
    documentoId = doc.id;
    bitacora(user, req, {
      companyId: ep.companyId,
      accion: "hospital.cda.guardar",
      entidad: "HospDocumento",
      entidadId: doc.id,
      detalle: { folio: ep.folio, tipo: meta.tipo, id: meta.id, intercambiable: meta.intercambiable, bytes: bytes.length },
    });
  }

  registrarAcceso({
    companyId: ep.companyId,
    accion: "EXPORTACION",
    episodioId: ep.id,
    pacienteId: ep.pacienteId,
    detalle: `CDA ${meta.tipo} ${ep.folio}`,
    user,
    req,
  });

  const nombreArchivo = `CDA-${ep.folio.replace(/[^\w.-]/g, "_")}-${meta.tipo}.xml`;
  const headers: Record<string, string> = {
    "Content-Type": "application/xml; charset=utf-8",
    "Content-Disposition": `attachment; filename="${nombreArchivo}"`,
    "Cache-Control": "private, no-store",
    "X-CDA-Id": meta.id,
    "X-CDA-Root": meta.oidRoot,
    "X-CDA-Intercambiable": meta.intercambiable ? "true" : "false",
    "X-CDA-Hash": meta.hash,
  };
  if (documentoId) headers["X-CDA-Documento-Id"] = documentoId;
  return new NextResponse(xml, { headers });
});
