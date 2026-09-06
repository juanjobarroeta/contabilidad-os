/**
 * GET /api/hospital/saeh/egresos/exportar?companyId=&anio=&mes=[&formato=txt|json&incluirIncompletos=1&previsualizar=1]
 *
 * Genera EGR-{EE}{III}-{AA}{MM}.TXT con los egresos del mes (GIIS-B002-05-09):
 * ANSI (Latin-1), el encabezado exacto del archivo muestra de la DGIS, «|»
 * entre campos, «&» entre repeticiones, «#» dentro de las compuestas y «||»
 * cuando no aplica. Sólo entran las hojas sin errores (COMPLETO), salvo
 * incluirIncompletos=1 (para revisar en la herramienta de la DGIS; esos no se
 * marcan). Asigna folioSaeh AAMM#### a quien no lo tenga, marca EXPORTADO con
 * fecha y archivo y registra HospAcceso EXPORTACION. previsualizar=1 arma el
 * archivo con folios provisionales sin tocar nada. El cifrado 3DES (.CIF) lo
 * hace la herramienta de la DGIS.
 */

import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule, requireWriter } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error } from "@/lib/hospital/http";
import { registrarAcceso } from "@/lib/hospital/accesos";
import { catalogoPrisma } from "@/lib/hospital/saeh/catalogo";
import { cargarEstablecimiento, cargarFuentesSaeh, type ContextoSaeh } from "@/lib/hospital/saeh/contexto";
import { bytesArchivoSaeh, formatearFolioSaeh, nombreArchivoSaeh, prefijoFolioSaeh, siguienteConsecutivoSaeh, textoArchivoSaeh } from "@/lib/hospital/saeh/exportar";
import { prepararContexto } from "@/lib/hospital/saeh/prellenar";
import { construirRegistro, type RegistroSaeh } from "@/lib/hospital/saeh/registro";
import { validarSaeh, type ValidacionSaeh } from "@/lib/hospital/saeh/validar";
import { periodoDeQuery, whereEgresosDelMes } from "@/lib/hospital/saeh/periodo";

interface Candidato {
  ctx: ContextoSaeh;
  validacion: ValidacionSaeh;
  completo: boolean;
  folio: string | null;
}

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  const previsualizar = searchParams.get("previsualizar") === "1";
  const { user } = previsualizar ? await requireMembership(companyId, undefined, req) : await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const periodo = periodoDeQuery(searchParams);
  if (!periodo) return error("anio (aaaa) y mes (1-12) inválidos");
  const { anio, mes } = periodo;
  const formato = (searchParams.get("formato") ?? "txt").toLowerCase();
  if (formato !== "txt" && formato !== "json") return error("formato debe ser txt o json");
  const incluirIncompletos = searchParams.get("incluirIncompletos") === "1";
  const hoy = new Date();

  const establecimiento = await cargarEstablecimiento(prisma, companyId);
  if (!establecimiento.clues) return error("Configura la CLUES del establecimiento (PUT /api/hospital/config) antes de exportar al SEUL", 409);

  const fuentes = await cargarFuentesSaeh(prisma, { companyId, where: whereEgresosDelMes(anio, mes), establecimiento });
  const catalogo = catalogoPrisma(prisma);
  const candidatos: Candidato[] = [];
  for (const f of fuentes) {
    const ctx = await prepararContexto(f, catalogo, hoy);
    const validacion = await validarSaeh(ctx, catalogo);
    candidatos.push({ ctx, validacion, completo: validacion.errores.length === 0, folio: f.fila?.folioSaeh ?? null });
  }
  const seleccion = candidatos.filter((c) => c.completo || incluirIncompletos);
  const omitidos = candidatos.filter((c) => !c.completo && !incluirIncompletos);
  if (!seleccion.length) {
    return error(
      fuentes.length
        ? `Ninguno de los ${fuentes.length} egresos de ${String(mes).padStart(2, "0")}/${anio} tiene la hoja SAEH completa; revisa los pendientes o usa incluirIncompletos=1`
        : `No hay egresos hospitalarios en ${String(mes).padStart(2, "0")}/${anio}`,
      409
    );
  }

  const nombre = nombreArchivoSaeh(establecimiento.clues, establecimiento.institucion, anio, mes);
  const prefijo = prefijoFolioSaeh(anio, mes);

  if (previsualizar) {
    // Folios provisionales para los que no tienen: no se guardan.
    const existentes = await prisma.hospEgresoSaeh.findMany({ where: { companyId, folioSaeh: { startsWith: prefijo } }, select: { folioSaeh: true } });
    let n = siguienteConsecutivoSaeh(existentes.map((e) => e.folioSaeh), anio, mes);
    for (const c of seleccion) if (!c.folio) c.folio = formatearFolioSaeh(anio, mes, n++);
  } else {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hosp-saeh:${companyId}:${prefijo}`}))`;
      const existentes = await tx.hospEgresoSaeh.findMany({ where: { companyId, folioSaeh: { startsWith: prefijo } }, select: { folioSaeh: true } });
      let n = siguienteConsecutivoSaeh(existentes.map((e) => e.folioSaeh), anio, mes);
      for (const c of seleccion) {
        if (!c.folio) c.folio = formatearFolioSaeh(anio, mes, n++);
        const validacion = c.validacion as unknown as Prisma.InputJsonValue;
        const marca = c.completo ? { estado: "EXPORTADO" as const, exportadoAt: hoy, exportadoArchivo: nombre } : { estado: "PENDIENTE" as const };
        await tx.hospEgresoSaeh.upsert({
          where: { episodioId: c.ctx.fuente.episodio.id },
          create: { companyId, episodioId: c.ctx.fuente.episodio.id, folioSaeh: c.folio, validacion, ...marca },
          update: { folioSaeh: c.folio, validacion, ...marca },
        });
      }
      // Lo que se creía COMPLETO y hoy tiene errores vuelve a PENDIENTE con su validación fresca.
      for (const c of omitidos) {
        if (!c.ctx.fuente.fila || c.ctx.fuente.fila.estado === "PENDIENTE") continue;
        await tx.hospEgresoSaeh.update({
          where: { episodioId: c.ctx.fuente.episodio.id },
          data: { estado: "PENDIENTE", validacion: c.validacion as unknown as Prisma.InputJsonValue },
        });
      }
    });
    const detalle = `SAEH ${nombre} · ${seleccion.length} egresos${incluirIncompletos ? ` (${seleccion.filter((c) => !c.completo).length} incompletos)` : ""}`;
    registrarAcceso({ companyId, accion: "EXPORTACION", detalle, user, req });
    bitacora(user, req, {
      companyId,
      accion: "hospital.saeh.exportar",
      entidad: "HospEgresoSaeh",
      entidadId: nombre,
      detalle: { archivo: nombre, anio, mes, egresos: seleccion.length, omitidos: omitidos.length, incluirIncompletos, folios: seleccion.map((c) => c.folio) },
    });
  }

  const registros: RegistroSaeh[] = seleccion.map((c) => construirRegistro({ fuente: c.ctx.fuente, hoja: c.ctx.hoja, paciente: c.ctx.paciente, edad: c.ctx.edad, folio: c.folio }));

  const resumenEgresos = seleccion.map((c) => ({
    episodioId: c.ctx.fuente.episodio.id,
    folio: c.ctx.fuente.episodio.folio,
    folioSaeh: c.folio,
    estado: previsualizar ? (c.ctx.fuente.fila?.estado ?? "PENDIENTE") : c.completo ? "EXPORTADO" : "PENDIENTE",
    completo: c.completo,
    errores: c.validacion.errores.length,
    advertencias: c.validacion.advertencias.length,
  }));
  const resumenOmitidos = omitidos.map((c) => ({
    episodioId: c.ctx.fuente.episodio.id,
    folio: c.ctx.fuente.episodio.folio,
    errores: c.validacion.errores.length,
    validacion: c.validacion,
  }));

  if (formato === "json") {
    return NextResponse.json({
      archivo: nombre,
      anio,
      mes,
      previsualizacion: previsualizar,
      registros: registros.length,
      egresos: resumenEgresos,
      omitidos: resumenOmitidos,
      texto: textoArchivoSaeh(registros),
    });
  }

  const bytes = bytesArchivoSaeh(registros);
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=ISO-8859-1",
      "Content-Disposition": `attachment; filename="${nombre}"`,
      "Content-Length": String(bytes.length),
      "X-SAEH-Archivo": nombre,
      "X-SAEH-Egresos": String(registros.length),
      "X-SAEH-Omitidos": String(omitidos.length),
      "X-SAEH-Previsualizacion": previsualizar ? "1" : "0",
    },
  });
});
