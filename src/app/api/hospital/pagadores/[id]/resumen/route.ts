/**
 * GET /api/hospital/pagadores/[id]/resumen?companyId=…
 *
 * El convenio de cabo a rabo (P4): a qué pacientes atiende, qué episodios le
 * amparan, cuánto se le facturó, cuánto ha pagado y qué tan viejo está el
 * saldo. Nada de esto se captura: los episodios pueden venir de piso o
 * reconstruidos de los CFDIs (`origen`), y el dinero sale de las facturas.
 *
 * La evidencia de cobro es la misma de cartera y del perfil del contacto (PUE
 * liquidada en su emisión; PPD por lo conciliado en banco o lo amparado con
 * REPs, lo que sea mayor) y la antigüedad se mide desde la FECHA del CFDI, en
 * los cortes 0-30 / 31-60 / 61-90 / 90+.
 *
 * `facturado` cuenta las facturas LIGADAS a los episodios del convenio (por
 * los cargos); las que están a su RFC pero todavía no cuelgan de ningún
 * expediente se listan con `episodioId: null` y se suman aparte en
 * `facturadoSinEpisodio`, para que se vea lo que falta por conciliar. Las
 * notas de crédito no son cartera y no entran (viven en el perfil del
 * contacto). Sólo lectura.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AuthzError, requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import {
  agingVacio,
  amparadoDe,
  amparadoPorReps,
  bucketAging,
  conciliadoDe,
  diasDesde,
  pagadoPorEvidencia,
  r2,
  sumarAging,
} from "@/lib/hospital/cobranza";
import { nombrePaciente } from "@/lib/hospital/formato";
import { customerResumen, pagadorResumen, totalesCargos } from "@/lib/hospital/serializar";

const FACTURA_SELECT = {
  id: true,
  uuid: true,
  serie: true,
  folio: true,
  fecha: true,
  total: true,
  status: true,
  metodoPago: true,
  tipoSat: true,
  conciliacionDetalles: { select: { montoAsignado: true } },
} as const;

type FilaFactura = {
  id: string;
  uuid: string | null;
  serie: string | null;
  folio: string | null;
  fecha: Date;
  total: number;
  status: string;
  metodoPago: string;
  tipoSat: string | null;
  conciliacionDetalles: Array<{ montoAsignado: unknown }>;
};

export const GET = withHospital(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const { id } = await ctx.params;
  const pagador = await prisma.hospPagador.findUnique({
    where: { id },
    include: { customer: { select: { id: true, razonSocial: true, rfc: true } } },
  });
  if (!pagador) throw new AuthzError(404, "Convenio no encontrado");

  const companyId = new URL(req.url).searchParams.get("companyId");
  if (companyId && companyId !== pagador.companyId) return error("El convenio no es de esa empresa", 404);

  await requireMembership(pagador.companyId, undefined, req);
  await requireModule(pagador.companyId, "HOSPITAL", req);

  const [episodiosDb, delRfc] = await Promise.all([
    prisma.hospEpisodio.findMany({
      where: { companyId: pagador.companyId, pagadorId: id },
      select: {
        id: true,
        folio: true,
        tipo: true,
        estado: true,
        origen: true,
        fechaIngreso: true,
        fechaAlta: true,
        paciente: { select: { id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true } },
        cargos: {
          select: { importe: true, ivaTasa: true, cancelado: true, invoice: { select: FACTURA_SELECT } },
        },
      },
      orderBy: { fechaIngreso: "desc" },
      take: 500,
    }),
    pagador.customerId
      ? prisma.invoice.findMany({
          where: { companyId: pagador.companyId, customerId: pagador.customerId, tipo: "INGRESO", status: { not: "CANCELLED" } },
          select: FACTURA_SELECT,
          orderBy: { fecha: "desc" },
          take: 1000,
        })
      : Promise.resolve([]),
  ]);

  // ── Facturas: las que amparan cargos del convenio y las que están a su RFC ──
  const facturas = new Map<string, FilaFactura>();
  const episodioDeFactura = new Map<string, string>();
  const numero = (f: { total: unknown }) => Number(f.total);
  for (const e of episodiosDb) {
    for (const c of e.cargos) {
      if (!c.invoice || c.invoice.status === "CANCELLED" || (c.invoice.tipoSat ?? "I") === "E") continue;
      facturas.set(c.invoice.id, { ...c.invoice, total: numero(c.invoice) });
      if (!episodioDeFactura.has(c.invoice.id)) episodioDeFactura.set(c.invoice.id, e.id);
    }
  }
  for (const f of delRfc) {
    if ((f.tipoSat ?? "I") === "E") continue;
    if (!facturas.has(f.id)) facturas.set(f.id, { ...f, total: numero(f) });
  }

  const amparado = await amparadoPorReps(prisma, [...facturas.values()].map((f) => f.uuid));
  const hoy = new Date();
  const evidencia = new Map<string, { pagado: number; saldo: number }>();
  for (const f of facturas.values()) {
    evidencia.set(
      f.id,
      pagadoPorEvidencia({
        metodoPago: f.metodoPago,
        total: f.total,
        conciliado: conciliadoDe(f.conciliacionDetalles),
        amparadoRep: amparadoDe(amparado, f.uuid),
      })
    );
  }

  // ── Episodios y pacientes ─────────────────────────────────────────────────
  type FilaPaciente = { id: string; nombre: string; episodios: number; ultimaAtencion: Date; saldo: number };
  const pacientes = new Map<string, FilaPaciente>();
  const aging = agingVacio();
  let facturado = 0;
  let cobrado = 0;

  const episodios = episodiosDb.map((e) => {
    const totales = totalesCargos(e.cargos);
    const suyas = [...facturas.values()].filter((f) => episodioDeFactura.get(f.id) === e.id);
    const facturadoEp = r2(suyas.reduce((s, f) => s + f.total, 0));
    const cobradoEp = r2(suyas.reduce((s, f) => s + (evidencia.get(f.id)?.pagado ?? 0), 0));
    facturado = r2(facturado + facturadoEp);
    cobrado = r2(cobrado + cobradoEp);

    const atencion = e.fechaAlta ?? e.fechaIngreso;
    const fila = pacientes.get(e.paciente.id) ?? {
      id: e.paciente.id,
      nombre: nombrePaciente(e.paciente),
      episodios: 0,
      ultimaAtencion: atencion,
      saldo: 0,
    };
    fila.episodios += 1;
    if (atencion > fila.ultimaAtencion) fila.ultimaAtencion = atencion;
    fila.saldo = r2(fila.saldo + facturadoEp - cobradoEp);
    pacientes.set(e.paciente.id, fila);

    return {
      id: e.id,
      folio: e.folio,
      paciente: nombrePaciente(e.paciente),
      pacienteId: e.paciente.id,
      tipo: e.tipo,
      estado: e.estado,
      origen: e.origen,
      fechaIngreso: e.fechaIngreso,
      fechaAlta: e.fechaAlta,
      total: totales.total,
      facturado: facturadoEp,
      saldo: r2(facturadoEp - cobradoEp),
    };
  });

  // La antigüedad se arma sólo con lo ligado: es el saldo que el convenio
  // reconoce contra un expediente.
  for (const f of facturas.values()) {
    if (!episodioDeFactura.has(f.id)) continue;
    const saldo = evidencia.get(f.id)?.saldo ?? 0;
    if (saldo > 0) sumarAging(aging, bucketAging(f.fecha, hoy), saldo);
  }

  const sueltas = [...facturas.values()].filter((f) => !episodioDeFactura.has(f.id));

  return NextResponse.json({
    pagador: { ...pagador, ...pagadorResumen(pagador), customer: customerResumen(pagador.customer) },
    resumen: {
      pacientes: pacientes.size,
      episodios: episodios.length,
      facturado,
      cobrado,
      saldo: r2(facturado - cobrado),
      aging,
      facturas: facturas.size,
      facturadoSinEpisodio: r2(sueltas.reduce((s, f) => s + f.total, 0)),
      facturasSinEpisodio: sueltas.length,
    },
    pacientes: [...pacientes.values()].sort((a, b) => +b.ultimaAtencion - +a.ultimaAtencion),
    episodios,
    facturas: [...facturas.values()]
      .sort((a, b) => +b.fecha - +a.fecha)
      .map((f) => ({
        id: f.id,
        uuid: f.uuid,
        serie: f.serie,
        folio: f.folio,
        fecha: f.fecha,
        total: f.total,
        status: f.status,
        metodoPago: f.metodoPago,
        episodioId: episodioDeFactura.get(f.id) ?? null,
        pagado: evidencia.get(f.id)?.pagado ?? 0,
        saldo: evidencia.get(f.id)?.saldo ?? 0,
        dias: diasDesde(f.fecha, hoy),
        aging: bucketAging(f.fecha, hoy),
      })),
  });
});
