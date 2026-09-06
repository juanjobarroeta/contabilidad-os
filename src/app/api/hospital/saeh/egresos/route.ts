/**
 * GET /api/hospital/saeh/egresos?companyId=&anio=&mes=[&revalidar=1]
 *
 * Los egresos hospitalarios del mes para el SEUL: episodios HOSPITALIZACION y
 * AMBULATORIO con fecha de alta en el mes local (URGENCIAS y CONSULTA no son
 * egreso hospitalario). Cada uno con el estado de su hoja SAEH, cuántos
 * errores/advertencias tiene y su folio, más el resumen y el vencimiento
 * estimado del calendario SEUL. Sin hoja guardada (o con revalidar=1) la
 * validación se calcula al vuelo y no se persiste: eso lo hace el PUT.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { catalogoPrisma } from "@/lib/hospital/saeh/catalogo";
import { cargarFuentesSaeh } from "@/lib/hospital/saeh/contexto";
import { prepararContexto } from "@/lib/hospital/saeh/prellenar";
import { validarSaeh, type ValidacionSaeh } from "@/lib/hospital/saeh/validar";
import { periodoDeQuery, whereEgresosDelMes } from "@/lib/hospital/saeh/periodo";
import { vencimientoSeul } from "@/lib/hospital/saeh/vencimiento";
import { nombreCompleto } from "@/lib/hospital/util";

function validacionGuardada(json: unknown): ValidacionSaeh | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const v = json as Record<string, unknown>;
  if (!Array.isArray(v.errores) || !Array.isArray(v.advertencias)) return null;
  return v as unknown as ValidacionSaeh;
}

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");
  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const periodo = periodoDeQuery(searchParams);
  if (!periodo) return error("anio (aaaa) y mes (1-12) inválidos");
  const { anio, mes } = periodo;
  const revalidar = searchParams.get("revalidar") === "1";
  const hoy = new Date();

  const fuentes = await cargarFuentesSaeh(prisma, { companyId, where: whereEgresosDelMes(anio, mes) });
  const catalogo = catalogoPrisma(prisma);

  const egresos = [];
  const resumen = { total: fuentes.length, completos: 0, pendientes: 0, exportados: 0, sinHoja: 0, conErrores: 0 };
  for (const f of fuentes) {
    const guardada = revalidar ? null : validacionGuardada(f.fila?.validacion);
    let validacion = guardada;
    if (!validacion) {
      const ctx = await prepararContexto(f, catalogo, hoy);
      validacion = await validarSaeh(ctx, catalogo);
    }
    const estado = f.fila?.estado ?? "PENDIENTE";
    if (!f.fila) resumen.sinHoja++;
    if (estado === "COMPLETO") resumen.completos++;
    else if (estado === "EXPORTADO") resumen.exportados++;
    else resumen.pendientes++;
    if (validacion.errores.length) resumen.conErrores++;
    egresos.push({
      episodioId: f.episodio.id,
      folio: f.episodio.folio,
      folioSaeh: f.fila?.folioSaeh ?? null,
      tipo: f.episodio.tipo,
      paciente: { id: f.paciente.id, nombreCompleto: nombreCompleto(f.paciente), curp: f.paciente.curp, sexo: f.paciente.sexo },
      medico: f.medico ? { id: f.medico.id, nombre: f.medico.nombre } : null,
      fechaIngreso: f.episodio.fechaIngreso,
      fechaEgreso: f.episodio.fechaAlta,
      motivoEgreso: f.episodio.motivoEgreso,
      diagnosticoEgresoCie10: f.episodio.diagnosticoEgresoCie10,
      hoja: !!f.fila,
      estado,
      errores: validacion.errores.length,
      advertencias: validacion.advertencias.length,
      validacionGuardada: !!guardada,
      exportadoAt: f.fila?.exportadoAt ?? null,
      exportadoArchivo: f.fila?.exportadoArchivo ?? null,
    });
  }

  const establecimiento = fuentes[0]?.establecimiento ?? null;
  return NextResponse.json({
    anio,
    mes,
    establecimiento: establecimiento ? { clues: establecimiento.clues, institucion: establecimiento.institucion, nombre: establecimiento.nombre } : null,
    vencimiento: vencimientoSeul(anio, mes, hoy),
    resumen,
    egresos,
  });
});
