// ─────────────────────────────────────────────────────────────────────────────
// Perfil 360° de un contacto (cliente o proveedor) para el módulo HOSPITAL.
//
// Misma base que el perfil del vertical automotriz — facturas con evidencia
// de pago (conciliación + REPs por UUID normalizado), anticipos y notas de
// crédito aparte — sin unidades/taller/refacciones, y con lo que un hospital
// necesita ver del contacto:
//   • aging del saldo abierto (0-30 / 31-60 / 61-90 / 90+ días desde la fecha
//     del CFDI), porque la cobranza a aseguradoras se administra por plazo;
//   • el CONVENIO (HospPagador) ligado a este RFC, si lo hay;
//   • los episodios facturados a este RFC o a su convenio, con el total de la
//     cuenta;
//   • los pacientes cuyo receptor fiscal por default es este contacto.
// Solo lectura.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  acumularAging,
  agingVacio,
  amparadoDe,
  amparadoPorReps,
  bucketAging,
  conciliadoDe,
  pagadoPorEvidencia,
  r2,
  sumarAging,
  type Aging,
} from "./cobranza";
import { nombrePaciente, totalCargo } from "./formato";

type Db = PrismaClient | Prisma.TransactionClient;

export interface FacturaPerfil {
  id: string;
  uuid: string | null;
  serie: string | null;
  folio: string | null;
  /** Presente sólo si el CFDI lo timbró el PAC desde aquí: habilita el PDF. */
  facturapiId: string | null;
  fecha: Date;
  total: number;
  metodoPago: string;
  pagado: number;
  amparadoRep: number;
  repPendiente: number;
  saldo: number;
  /** Días desde la fecha del CFDI y corte de antigüedad (sólo informativo si saldo = 0). */
  dias: number;
  aging: "0-30" | "31-60" | "61-90" | "90+";
}

interface CfdiResumen {
  id: string;
  uuid: string | null;
  serie: string | null;
  folio: string | null;
  facturapiId: string | null;
  fecha: Date;
  total: number;
}

export interface PerfilContactoHospital {
  contacto: { id: string; rfc: string; razonSocial: string; email: string | null; phone: string | null };
  direccion: "CLIENTE" | "PROVEEDOR";
  resumen: {
    numFacturas: number;
    totalFacturado: number;
    totalPagado: number;
    saldo: number;
    repPendienteMonto: number;
    repPendienteFacturas: number;
    totalNotasCredito: number;
    totalAnticipos: number;
    /** Saldo abierto con más de 30 días. */
    masDe30: number;
  };
  facturas: FacturaPerfil[];
  anticipos: CfdiResumen[];
  notasCredito: CfdiResumen[];
  /** Saldo abierto por antigüedad. */
  aging: Aging;
  /** Convenio ligado a este RFC (el primero si hay varios; todos en `pagadores`). */
  pagador: PagadorPerfil | null;
  pagadores: PagadorPerfil[];
  episodios: Array<{
    id: string;
    folio: string;
    paciente: string;
    estado: string;
    fechaIngreso: Date;
    fechaAlta: Date | null;
    total: number;
    /** Por qué liga con este contacto: receptor fiscal directo o vía convenio. */
    via: "RECEPTOR" | "PAGADOR";
  }>;
  pacientes: Array<{ id: string; nombre: string; activo: boolean }>;
}

export interface PagadorPerfil {
  id: string;
  nombre: string;
  tipo: string;
  tabulador: string | null;
  deducible: number | null;
  coaseguroPct: number | null;
  plazoDias: number;
  topeAutorizacion: number | null;
  vigenciaFin: Date | null;
  activo: boolean;
}

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * Arma el perfil. Devuelve null si el contacto no existe o es de otra empresa
 * (fail-closed). `hoy` se inyecta para fijar la antigüedad en pruebas.
 */
export async function perfilContactoHospital(
  db: Db,
  companyId: string,
  customerId: string,
  direccion: "CLIENTE" | "PROVEEDOR",
  hoy: Date = new Date()
): Promise<PerfilContactoHospital | null> {
  const contacto = await db.customer.findUnique({
    where: { id: customerId },
    select: { id: true, companyId: true, rfc: true, razonSocial: true, email: true, phone: true },
  });
  if (!contacto || contacto.companyId !== companyId) return null;

  const tipo = direccion === "CLIENTE" ? "INGRESO" : "EGRESO";
  const todasDb = (
    await db.invoice.findMany({
      where: { companyId, customerId, tipo, status: { not: "CANCELLED" } },
      select: {
        id: true,
        uuid: true,
        serie: true,
        folio: true,
        fecha: true,
        total: true,
        metodoPago: true,
        tipoSat: true,
        facturapiId: true,
        // Prefiltro barato de anticipos (clave 84111506): sólo se pregunta si
        // el XML contiene la clave, no se parsea.
        rawXml: true,
        conciliacionDetalles: { select: { montoAsignado: true } },
      },
      orderBy: { fecha: "desc" },
    })
  ).map((f) => ({ ...f, total: Number(f.total) }));

  // Anticipo: CFDI cuyo ÚNICO concepto es la clave 84111506 del SAT — se marca
  // sin sacarlo de `facturas` (fiscalmente es ingreso timbrado) para que el
  // contador vea el monto que está contado dos veces.
  const esAnticipo = (raw: string | null) =>
    raw != null &&
    raw.includes('ClaveProdServ="84111506"') &&
    (raw.match(/<(?:[\w-]+:)?Concepto\b/gi) ?? []).length === 1;
  const resumenCfdi = (f: (typeof todasDb)[number]): CfdiResumen => ({
    id: f.id,
    uuid: f.uuid,
    serie: f.serie,
    folio: f.folio,
    facturapiId: f.facturapiId,
    fecha: f.fecha,
    total: f.total,
  });

  const facturasDb = todasDb.filter((f) => (f.tipoSat ?? "I") !== "E");
  const anticipos = facturasDb.filter((f) => esAnticipo(f.rawXml)).map(resumenCfdi);
  const notasCredito = todasDb.filter((f) => (f.tipoSat ?? "I") === "E").map(resumenCfdi);

  const amparado = await amparadoPorReps(db, facturasDb.map((f) => f.uuid));

  const aging = agingVacio();
  let masDe30 = 0;
  const facturas: FacturaPerfil[] = facturasDb.map((f) => {
    const conciliado = conciliadoDe(f.conciliacionDetalles);
    const amparadoRep = amparadoDe(amparado, f.uuid);
    const ev = pagadoPorEvidencia({ metodoPago: f.metodoPago, total: f.total, conciliado, amparadoRep });
    const dias = Math.max(0, Math.floor((hoy.getTime() - f.fecha.getTime()) / DIA_MS));
    const bucket = bucketAging(f.fecha, hoy);
    if (ev.saldo > 0) {
      sumarAging(aging, bucket, ev.saldo);
      if (bucket !== "0-30") masDe30 += ev.saldo;
    }
    return {
      id: f.id,
      uuid: f.uuid,
      serie: f.serie,
      folio: f.folio,
      facturapiId: f.facturapiId,
      fecha: f.fecha,
      total: f.total,
      metodoPago: f.metodoPago,
      pagado: ev.pagado,
      amparadoRep,
      repPendiente: ev.repPendiente,
      saldo: ev.saldo,
      dias,
      aging: bucket,
    };
  });

  // Lo hospitalario: convenio, episodios y pacientes ligados a este RFC.
  const [pagadoresDb, episodiosDb, pacientesDb] = await Promise.all([
    db.hospPagador.findMany({
      where: { companyId, customerId },
      select: {
        id: true, nombre: true, tipo: true, tabulador: true, deducible: true, coaseguroPct: true,
        plazoDias: true, topeAutorizacion: true, vigenciaFin: true, activo: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    db.hospEpisodio.findMany({
      where: { companyId, OR: [{ customerId }, { pagador: { customerId } }] },
      select: {
        id: true,
        folio: true,
        estado: true,
        fechaIngreso: true,
        fechaAlta: true,
        customerId: true,
        paciente: { select: { nombre: true, apellidoPaterno: true, apellidoMaterno: true } },
        cargos: { where: { cancelado: false }, select: { importe: true, ivaTasa: true } },
      },
      orderBy: { fechaIngreso: "desc" },
      take: 100,
    }),
    db.hospPaciente.findMany({
      where: { companyId, customerId },
      select: { id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true, activo: true },
      orderBy: [{ apellidoPaterno: "asc" }, { nombre: "asc" }],
    }),
  ]);

  const pagadores: PagadorPerfil[] = pagadoresDb.map((p) => ({
    id: p.id,
    nombre: p.nombre,
    tipo: p.tipo,
    tabulador: p.tabulador,
    deducible: p.deducible == null ? null : Number(p.deducible),
    coaseguroPct: p.coaseguroPct == null ? null : Number(p.coaseguroPct),
    plazoDias: p.plazoDias,
    topeAutorizacion: p.topeAutorizacion == null ? null : Number(p.topeAutorizacion),
    vigenciaFin: p.vigenciaFin,
    activo: p.activo,
  }));

  const conRepPendiente = facturas.filter((f) => f.repPendiente > 1); // tolerancia de centavos
  return {
    contacto: {
      id: contacto.id,
      rfc: contacto.rfc,
      razonSocial: contacto.razonSocial,
      email: contacto.email,
      phone: contacto.phone,
    },
    direccion,
    resumen: {
      numFacturas: facturas.length,
      totalFacturado: r2(facturas.reduce((s, f) => s + f.total, 0)),
      totalPagado: r2(facturas.reduce((s, f) => s + f.pagado, 0)),
      saldo: r2(facturas.reduce((s, f) => s + f.saldo, 0)),
      repPendienteMonto: r2(conRepPendiente.reduce((s, f) => s + f.repPendiente, 0)),
      repPendienteFacturas: conRepPendiente.length,
      totalNotasCredito: r2(notasCredito.reduce((s, n) => s + n.total, 0)),
      totalAnticipos: r2(anticipos.reduce((s, a) => s + a.total, 0)),
      masDe30: r2(masDe30),
    },
    facturas,
    anticipos,
    notasCredito,
    aging: acumularAging(agingVacio(), aging),
    pagador: pagadores[0] ?? null,
    pagadores,
    episodios: episodiosDb.map((e) => ({
      id: e.id,
      folio: e.folio,
      paciente: nombrePaciente(e.paciente),
      estado: e.estado,
      fechaIngreso: e.fechaIngreso,
      fechaAlta: e.fechaAlta,
      total: r2(e.cargos.reduce((s, c) => s + totalCargo(c), 0)),
      via: e.customerId === customerId ? "RECEPTOR" : "PAGADOR",
    })),
    pacientes: pacientesDb.map((p) => ({ id: p.id, nombre: nombrePaciente(p), activo: p.activo })),
  };
}
