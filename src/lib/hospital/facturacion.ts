// ─────────────────────────────────────────────────────────────────────────────
// Facturar la cuenta del episodio (paso 2 de «Facturación desde el satélite»).
//
// La cuenta NO se factura de un golpe: cada cargo va a quien corresponde —el
// pagador, el paciente, un tercero (un familiar, la empresa)— o a ninguno en
// particular (cobro de contado sin factura individual → factura global del
// mes a público en general). La unidad es el CARGO, y la regla que sostiene
// todo lo demás es la de siempre: un cargo ampara UN CFDI (`invoiceId`).
// De ella dependen el «facturado» de la cuenta, el reparto por categoría de
// la contabilidad (lib/contabilidad/hospital.ts), el vinculador automático de
// CFDIs (episodios-vivos-cfdi.ts) y el candado de cancelar cargos.
//
// Por eso partir un cargo entre dos receptores NO es un porcentaje colgado del
// cargo: es DIVIDIRLO en dos cargos que suman lo mismo (por cantidad o por
// importe), y cada mitad sigue la regla de un CFDI.
//
// Ciclo de un cargo:
//   pendiente ──(prefactura)──▶ en prefactura ──(timbrar)──▶ facturado
//        │                         └──(descartar)──▶ pendiente
//        └──(público en general)──▶ factura global del mes ──▶ facturado
//
// Los honorarios NO se facturan aquí: hoy cada médico factura los suyos
// (docs/HOSPITAL.md). «A cuenta de terceros» queda como opción.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { HospitalError } from "./errores";
import { rangoMesLocal } from "./tz";
import { SIN_CFDI_VIGENTE, SIN_PREFACTURA_PENDIENTE } from "./global-por-cobro";
import { crearPrefactura, type Actor } from "@/lib/facturas/prefacturas";
import type { StampInput, StampItem } from "@/lib/facturas/stamp";

type Db = PrismaClient | Prisma.TransactionClient;

export const RFC_PUBLICO_GENERAL = "XAXX010101000";
/** Clave y unidad que el SAT pide en los conceptos de la factura global. */
export const CLAVE_GLOBAL = "01010101";
export const UNIDAD_GLOBAL = "ACT";
/** Unidad SAT por default: servicio (E48) o pieza para insumos (H87). */
const UNIDAD_SERVICIO = "E48";
const UNIDAD_PIEZA = "H87";

const r2 = (n: number) => Math.round(n * 100) / 100;

export type EstadoFacturacion = "PENDIENTE" | "EN_PREFACTURA" | "PUBLICO_GENERAL" | "FACTURADO" | "HONORARIO" | "CANCELADO";

/** Lo que el cálculo necesita de un cargo (con servicio e insumo para las claves SAT). */
export interface CargoFacturable {
  id: string;
  episodioId: string;
  fecha: Date;
  categoria: string;
  descripcion: string;
  cantidad: unknown;
  precioUnitario: unknown;
  importe: unknown;
  ivaTasa: unknown;
  cancelado: boolean;
  invoiceId: string | null;
  prefacturaId: string | null;
  publicoGeneral: boolean;
  servicio?: { claveProdServ: string | null; claveUnidad: string | null } | null;
  lote?: { insumo?: { claveProdServ: string | null } | null } | null;
  prefactura?: { status: string } | null;
  invoice?: { status: string } | null;
}

/**
 * Un CFDI cancelado ya no ampara nada: su cargo vuelve a estar libre, sea
 * quien sea que lo haya marcado CANCELLED (la cancelación del hospital, el
 * cron de vigencia del SAT o la sincronización). Por eso se DERIVA aquí y no
 * se «suelta» el cargo en una sola ruta.
 */
export const facturaVigente = (c: Pick<CargoFacturable, "invoiceId" | "invoice">) =>
  Boolean(c.invoiceId) && c.invoice?.status !== "CANCELLED";

export function estadoFacturacion(c: CargoFacturable): EstadoFacturacion {
  if (c.cancelado) return "CANCELADO";
  // Una prefactura PENDIENTE manda aunque el cargo siga amparado por un CFDI:
  // es la sustitución en curso (el CFDI nuevo reemplazará al viejo).
  if (c.prefacturaId && (!c.prefactura || c.prefactura.status === "PENDIENTE")) return "EN_PREFACTURA";
  if (facturaVigente(c)) return "FACTURADO";
  if (c.categoria === "HONORARIO") return "HONORARIO";
  if (c.publicoGeneral) return "PUBLICO_GENERAL";
  return "PENDIENTE";
}

// Condición de BD equivalente a «libre»: sin CFDI vigente ni prefactura
// pendiente. Vive en global-por-cobro.ts, que la comparte con la caja.

/** Puede entrar a una prefactura (o marcarse para la global). */
export const esLibre = (c: CargoFacturable) => estadoFacturacion(c) === "PENDIENTE";

/** Claves SAT del concepto: las del tarifario; si no, las del insumo. */
export function clavesSat(c: CargoFacturable): { productKey: string | null; unitKey: string } {
  const deServicio = c.servicio?.claveProdServ?.trim();
  if (deServicio) return { productKey: deServicio, unitKey: c.servicio?.claveUnidad?.trim() || UNIDAD_SERVICIO };
  const deInsumo = c.lote?.insumo?.claveProdServ?.trim();
  if (deInsumo) return { productKey: deInsumo, unitKey: UNIDAD_PIEZA };
  return { productKey: null, unitKey: UNIDAD_SERVICIO };
}

/**
 * Nodo de IVA del concepto. Tasa 0 y exento llevan SIEMPRE su nodo (rate 0):
 * omitirlo no es lo mismo que exento para el SAT.
 */
export function impuestosCargo(ivaTasa: unknown): NonNullable<StampItem["product"]["taxes"]> {
  if (ivaTasa == null) return [{ type: "IVA", rate: 0, factor: "Exento", withholding: false }];
  return [{ type: "IVA", rate: Number(ivaTasa), factor: "Tasa", withholding: false }];
}

/**
 * Cargos → conceptos del CFDI, uno por cargo. Devuelve también los cargos a
 * los que les falta la clave SAT: sin ella Facturapi rechaza el borrador, y el
 * arreglo correcto es capturarla en el tarifario, no inventar una genérica.
 */
export function conceptosDeCargos(cargos: CargoFacturable[]): { items: StampItem[]; sinClave: CargoFacturable[] } {
  const items: StampItem[] = [];
  const sinClave: CargoFacturable[] = [];
  for (const c of cargos) {
    const { productKey, unitKey } = clavesSat(c);
    if (!productKey) { sinClave.push(c); continue; }
    const cantidad = Number(c.cantidad);
    const precio = Number(c.precioUnitario);
    // Un cargo dividido por importe queda como 1 × importe; el resto conserva
    // cantidad × precio unitario, que es lo que el paciente reconoce.
    const cuadra = Math.abs(r2(cantidad * precio) - r2(Number(c.importe))) < 0.01;
    items.push({
      quantity: cuadra ? cantidad : 1,
      product: {
        description: c.descripcion,
        product_key: productKey,
        unit_key: unitKey,
        price: cuadra ? precio : r2(Number(c.importe)),
        tax_included: false,
        taxes: impuestosCargo(c.ivaTasa),
      },
    });
  }
  return { items, sinClave };
}

/**
 * Conceptos de la factura global: uno por episodio (el «ticket») y tasa de
 * IVA —un concepto sólo lleva una tasa—, con la clave 01010101, la unidad ACT,
 * la descripción «Venta» y el folio del episodio como número de
 * identificación, que es como el SAT pide la factura a público en general.
 */
export function conceptosGlobales(cargos: Array<CargoFacturable & { folio: string }>): StampItem[] {
  const grupos = new Map<string, { folio: string; iva: unknown; importe: number }>();
  for (const c of cargos) {
    const clave = `${c.folio}|${c.ivaTasa == null ? "EXENTO" : Number(c.ivaTasa)}`;
    const g = grupos.get(clave) ?? { folio: c.folio, iva: c.ivaTasa, importe: 0 };
    g.importe = r2(g.importe + Number(c.importe));
    grupos.set(clave, g);
  }
  return [...grupos.values()]
    .filter((g) => g.importe > 0)
    .map((g) => ({
      quantity: 1,
      product: {
        description: "Venta",
        product_key: CLAVE_GLOBAL,
        unit_key: UNIDAD_GLOBAL,
        sku: g.folio,
        price: g.importe,
        tax_included: false,
        taxes: impuestosCargo(g.iva),
      },
    }));
}

// ── Lecturas ────────────────────────────────────────────────────────────────

const incluyeCargo = {
  servicio: { select: { claveProdServ: true, claveUnidad: true } },
  lote: { select: { insumo: { select: { claveProdServ: true } } } },
  prefactura: { select: { id: true, status: true, total: true, customer: { select: { razonSocial: true, rfc: true } } } },
  invoice: { select: { id: true, uuid: true, serie: true, folio: true, status: true, customer: { select: { razonSocial: true, rfc: true } } } },
} as const;

/** La cuenta vista para facturar: cada cargo con su estado y los receptores sugeridos. */
export async function facturacionEpisodio(db: Db, companyId: string, episodioId: string) {
  const ep = await db.hospEpisodio.findUnique({
    where: { id: episodioId },
    select: {
      id: true, companyId: true, folio: true,
      paciente: { select: { id: true, nombre: true, apellidoPaterno: true, apellidoMaterno: true, rfc: true, email: true, codigoPostal: true } },
      pagador: { select: { id: true, nombre: true, tipo: true, customer: { select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true } } } },
      customer: { select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true } },
      cargos: { orderBy: { fecha: "asc" }, include: incluyeCargo },
    },
  });
  if (!ep || ep.companyId !== companyId) throw new HospitalError(404, "Episodio no encontrado");

  // El paciente como receptor sólo si ya existe como cliente del hub con su RFC.
  const rfcPaciente = ep.paciente.rfc?.trim().toUpperCase();
  const clientePaciente = rfcPaciente
    ? await db.customer.findUnique({
        where: { companyId_rfc: { companyId, rfc: rfcPaciente } },
        select: { id: true, rfc: true, razonSocial: true, regimenFiscal: true, codigoPostal: true },
      })
    : null;

  const cargos = ep.cargos.map((c) => {
    const estado = estadoFacturacion(c);
    const { productKey, unitKey } = clavesSat(c);
    const importe = r2(Number(c.importe));
    const iva = c.ivaTasa == null ? 0 : r2(importe * Number(c.ivaTasa));
    return {
      id: c.id,
      fecha: c.fecha,
      categoria: c.categoria,
      descripcion: c.descripcion,
      cantidad: Number(c.cantidad),
      precioUnitario: Number(c.precioUnitario),
      importe,
      ivaTasa: c.ivaTasa == null ? null : Number(c.ivaTasa),
      iva,
      total: r2(importe + iva),
      estado,
      claveProdServ: productKey,
      claveUnidad: unitKey,
      prefactura: estado === "EN_PREFACTURA" && c.prefactura ? { id: c.prefactura.id, receptor: c.prefactura.customer } : null,
      factura: c.invoice ? { id: c.invoice.id, uuid: c.invoice.uuid, serie: c.invoice.serie, folio: c.invoice.folio, status: c.invoice.status, receptor: c.invoice.customer } : null,
    };
  });

  const suma = (e: EstadoFacturacion) => r2(cargos.filter((c) => c.estado === e).reduce((s, c) => s + c.total, 0));
  return {
    episodioId: ep.id,
    folio: ep.folio,
    receptores: {
      pagador: ep.pagador?.customer ? { ...ep.pagador.customer, etiqueta: ep.pagador.nombre, tipo: ep.pagador.tipo } : null,
      receptorFiscal: ep.customer,
      paciente: clientePaciente,
      pacienteDatos: { nombre: [ep.paciente.nombre, ep.paciente.apellidoPaterno, ep.paciente.apellidoMaterno].filter(Boolean).join(" "), rfc: ep.paciente.rfc, email: ep.paciente.email, codigoPostal: ep.paciente.codigoPostal },
    },
    cargos,
    totales: {
      pendiente: suma("PENDIENTE"),
      enPrefactura: suma("EN_PREFACTURA"),
      publicoGeneral: suma("PUBLICO_GENERAL"),
      facturado: suma("FACTURADO"),
      honorarios: suma("HONORARIO"),
    },
  };
}

// ── Escrituras ──────────────────────────────────────────────────────────────

async function cargosDelEpisodio(db: Db, companyId: string, episodioId: string, ids: string[]) {
  const unicos = [...new Set(ids)];
  const cargos = await db.hospCargo.findMany({
    where: { id: { in: unicos }, episodioId, companyId },
    include: incluyeCargo,
  });
  if (cargos.length !== unicos.length) throw new HospitalError(404, "Algún cargo no es de este episodio");
  return cargos;
}

function exigirLibres(cargos: CargoFacturable[] & Array<{ descripcion: string }>) {
  const ocupados = cargos.filter((c) => !esLibre(c));
  if (ocupados.length) {
    const motivo: Record<EstadoFacturacion, string> = {
      PENDIENTE: "", CANCELADO: "cancelado", FACTURADO: "ya facturado", HONORARIO: "honorario: lo factura el médico",
      EN_PREFACTURA: "ya está en otra prefactura", PUBLICO_GENERAL: "va a la factura global",
    };
    throw new HospitalError(409, `No se puede: ${ocupados.map((c) => `«${c.descripcion}» (${motivo[estadoFacturacion(c)]})`).join(", ")}.`);
  }
}

export interface DatosCfdi {
  formaPago: string;
  metodoPago: "PUE" | "PPD";
  usoCfdi: string;
  notes?: string;
}

/**
 * Prefactura con los cargos elegidos al receptor elegido. Primero el borrador
 * (Facturapi); después se «toman» los cargos con un update condicionado a que
 * sigan libres. Si otro usuario tomó alguno en ese instante, se descarta el
 * borrador recién creado y se contesta 409: nunca dos prefacturas con el
 * mismo cargo.
 */
export async function prefacturaDesdeCargos(
  args: { companyId: string; episodioId: string; customerId: string; cargoIds: string[]; datos: DatosCfdi; actor: Actor; req: Request },
) {
  if (!args.cargoIds.length) throw new HospitalError(400, "Elige al menos un cargo");
  const cargos = await cargosDelEpisodio(prisma, args.companyId, args.episodioId, args.cargoIds);
  exigirLibres(cargos);
  const { items, sinClave } = conceptosDeCargos(cargos);
  if (sinClave.length) {
    throw new HospitalError(422, `Falta la clave SAT de: ${sinClave.map((c) => `«${c.descripcion}»`).join(", ")}. Captúrala en Convenios y tarifario (servicio) o en Farmacia (insumo).`);
  }
  const input: StampInput = { companyId: args.companyId, customerId: args.customerId, ...args.datos, items };
  const r = await crearPrefactura(input, args.actor, args.req);
  if (r.status !== 201) return r;

  const prefacturaId = (r.body as { id: string }).id;
  const tomados = await prisma.hospCargo.updateMany({
    where: { id: { in: cargos.map((c) => c.id) }, cancelado: false, publicoGeneral: false, AND: [SIN_CFDI_VIGENTE, SIN_PREFACTURA_PENDIENTE] },
    // El CFDI cancelado que traía se suelta: al timbrar, el cargo amparará el nuevo.
    data: { prefacturaId, invoiceId: null },
  });
  if (tomados.count !== cargos.length) {
    await liberarYDescartar(prefacturaId, args.actor, args.req);
    throw new HospitalError(409, "Otro usuario tomó alguno de estos cargos al mismo tiempo. Recarga la cuenta.");
  }
  return r;
}

async function liberarYDescartar(prefacturaId: string, actor: Actor, req: Request) {
  const { cargarPrefactura, descartarPrefactura } = await import("@/lib/facturas/prefacturas");
  const b = await cargarPrefactura(prefacturaId);
  if (b) await descartarPrefactura(b, actor, req);
}

/** Marca (o desmarca) cargos para la factura global a público en general. */
export async function marcarPublicoGeneral(db: Db, companyId: string, episodioId: string, cargoIds: string[], valor: boolean) {
  const cargos = await cargosDelEpisodio(db, companyId, episodioId, cargoIds);
  if (valor) exigirLibres(cargos);
  else {
    const ajenos = cargos.filter((c) => estadoFacturacion(c) !== "PUBLICO_GENERAL");
    if (ajenos.length) throw new HospitalError(409, `Sólo se regresan cargos marcados para la global: ${ajenos.map((c) => `«${c.descripcion}»`).join(", ")}.`);
  }
  const r = await db.hospCargo.updateMany({
    where: { id: { in: cargos.map((c) => c.id) }, cancelado: false, AND: [SIN_CFDI_VIGENTE, SIN_PREFACTURA_PENDIENTE] },
    // Regresarlo a mano también suelta la liga con el cobro SIN CFDI que lo marcó.
    data: valor ? { publicoGeneral: true } : { publicoGeneral: false, publicoGeneralCobroId: null },
  });
  return { actualizados: r.count };
}

/**
 * Divide un cargo en dos que suman lo mismo, para mandar cada parte a un
 * receptor distinto. Por CANTIDAD (3 noches → 2 + 1, mismo precio) o por
 * IMPORTE (el coaseguro: la parte nueva queda como 1 × importe). La parte
 * nueva hereda categoría, IVA, servicio, médico y origen. No se dividen
 * cargos de farmacia amarrados a su movimiento de kardex: al cancelar una
 * mitad, el lote recuperaría la pieza completa.
 */
export async function dividirCargo(
  tx: Prisma.TransactionClient,
  args: { companyId: string; episodioId: string; cargoId: string; cantidad?: number; importe?: number; userId?: string | null },
) {
  const c = await tx.hospCargo.findUnique({ where: { id: args.cargoId }, include: { ...incluyeCargo, movimientoInsumo: { select: { id: true } } } });
  if (!c || c.companyId !== args.companyId || c.episodioId !== args.episodioId) throw new HospitalError(404, "Cargo no encontrado");
  exigirLibres([c]);
  if (c.movimientoInsumo) throw new HospitalError(409, "Este cargo salió de farmacia con su lote: no se divide. Cancélalo y aplica la cantidad correcta, o factúralo completo.");

  const cantidad = Number(c.cantidad);
  const precio = Number(c.precioUnitario);
  const importe = r2(Number(c.importe));
  let original: { cantidad: number; precioUnitario: number; importe: number };
  let nueva: { cantidad: number; precioUnitario: number; importe: number };

  if (args.cantidad != null) {
    const q = args.cantidad;
    if (!(q > 0 && q < cantidad)) throw new HospitalError(400, `La cantidad a separar va de 0 a ${cantidad} (sin incluirlos)`);
    nueva = { cantidad: q, precioUnitario: precio, importe: r2(q * precio) };
    original = { cantidad: cantidad - q, precioUnitario: precio, importe: r2(importe - nueva.importe) };
  } else if (args.importe != null) {
    const x = r2(args.importe);
    if (!(x > 0 && x < importe)) throw new HospitalError(400, `El importe a separar va de 0 a ${importe} (sin incluirlos)`);
    nueva = { cantidad: 1, precioUnitario: x, importe: x };
    const resto = r2(importe - x);
    original = { cantidad: 1, precioUnitario: resto, importe: resto };
  } else {
    throw new HospitalError(400, "Indica la cantidad o el importe a separar");
  }

  const actualizado = await tx.hospCargo.update({ where: { id: c.id }, data: original });
  const creado = await tx.hospCargo.create({
    data: {
      companyId: c.companyId,
      episodioId: c.episodioId,
      fecha: c.fecha,
      categoria: c.categoria,
      descripcion: c.descripcion,
      ...nueva,
      ivaTasa: c.ivaTasa,
      ivaContexto: c.ivaContexto,
      origen: c.origen,
      servicioId: c.servicioId,
      medicoId: c.medicoId,
      creadoPorUserId: args.userId ?? null,
    },
  });
  return { original: actualizado.id, nueva: creado.id };
}

// ── Factura global a público en general ─────────────────────────────────────

/** Cargos marcados para la global con fecha en el mes local, aún sin facturar. */
export async function cargosGlobales(db: Db, companyId: string, anio: number, mes: number) {
  const { desde, hasta } = rangoMesLocal(anio, mes);
  const cargos = await db.hospCargo.findMany({
    where: { companyId, publicoGeneral: true, cancelado: false, fecha: { gte: desde, lt: hasta }, AND: [SIN_CFDI_VIGENTE, SIN_PREFACTURA_PENDIENTE] },
    include: { ...incluyeCargo, episodio: { select: { folio: true } } },
    orderBy: { fecha: "asc" },
  });
  return cargos.map((c) => ({ ...c, folio: c.episodio.folio }));
}

/** El cliente «PUBLICO EN GENERAL» de la empresa; se crea la primera vez. */
async function clientePublicoGeneral(companyId: string) {
  const existente = await prisma.customer.findUnique({ where: { companyId_rfc: { companyId, rfc: RFC_PUBLICO_GENERAL } } });
  if (existente) return existente;
  const company = await prisma.company.findUnique({ where: { id: companyId }, select: { codigoPostal: true } });
  // CFDI 4.0: con el RFC genérico el domicilio fiscal del receptor es el CP
  // del lugar de expedición (el del emisor) y el régimen, 616.
  return prisma.customer.create({
    data: { companyId, rfc: RFC_PUBLICO_GENERAL, razonSocial: "PUBLICO EN GENERAL", regimenFiscal: "616", codigoPostal: company?.codigoPostal ?? null },
  });
}

export async function prefacturaGlobal(
  args: { companyId: string; anio: number; mes: number; formaPago: string; actor: Actor; req: Request },
) {
  const cargos = await cargosGlobales(prisma, args.companyId, args.anio, args.mes);
  if (!cargos.length) throw new HospitalError(409, "No hay cargos para la factura global de ese mes");
  const items = conceptosGlobales(cargos);
  const cliente = await clientePublicoGeneral(args.companyId);
  const input: StampInput = {
    companyId: args.companyId,
    customerId: cliente.id,
    formaPago: args.formaPago,
    metodoPago: "PUE",
    usoCfdi: "S01",
    items,
    global: { periodicity: "month", months: String(args.mes).padStart(2, "0"), year: args.anio },
  };
  const r = await crearPrefactura(input, args.actor, args.req);
  if (r.status !== 201) return r;
  const prefacturaId = (r.body as { id: string }).id;
  const tomados = await prisma.hospCargo.updateMany({
    where: { id: { in: cargos.map((c) => c.id) }, cancelado: false, publicoGeneral: true, AND: [SIN_CFDI_VIGENTE, SIN_PREFACTURA_PENDIENTE] },
    data: { prefacturaId, invoiceId: null },
  });
  if (tomados.count !== cargos.length) {
    await liberarYDescartar(prefacturaId, args.actor, args.req);
    throw new HospitalError(409, "Cambiaron los cargos del mes mientras se armaba la global. Vuelve a intentarlo.");
  }
  return r;
}

// ── Sustitución (cancelación con motivo 01) ─────────────────────────────────

/**
 * Prefactura que SUSTITUYE a un CFDI de la cuenta: los mismos cargos, el mismo
 * receptor y los mismos datos de pago (salvo que se cambien), con la relación
 * 04 al UUID viejo. Los cargos siguen amparados por el CFDI viejo mientras la
 * prefactura está pendiente —si se descarta, no pierden su factura—; al
 * timbrar pasan al nuevo, y entonces el viejo se cancela con motivo 01 y el
 * UUID nuevo. Es el orden que pide el SAT: primero el que sustituye.
 */
export async function prefacturaSustituta(args: {
  companyId: string;
  invoiceId: string;
  datos?: Partial<DatosCfdi>;
  customerId?: string;
  actor: Actor;
  req: Request;
}) {
  const vieja = await prisma.invoice.findUnique({
    where: { id: args.invoiceId },
    select: { id: true, companyId: true, uuid: true, status: true, customerId: true, formaPago: true, metodoPago: true, usoCfdi: true, customer: { select: { rfc: true } } },
  });
  if (!vieja || vieja.companyId !== args.companyId) throw new HospitalError(404, "Factura no encontrada");
  if (vieja.status !== "STAMPED" || !vieja.uuid) throw new HospitalError(409, "Sólo se sustituye un CFDI timbrado y vigente");
  if (vieja.customer?.rfc === RFC_PUBLICO_GENERAL) throw new HospitalError(409, "La factura global no se sustituye desde aquí: cancélala con motivo 02 y vuelve a armar la global del mes.");

  const cargos = await prisma.hospCargo.findMany({ where: { companyId: args.companyId, invoiceId: vieja.id, cancelado: false }, include: incluyeCargo });
  if (!cargos.length) throw new HospitalError(409, "Esta factura no ampara cargos de una cuenta: sustitúyela desde Facturación → Nueva prefactura con «sustituye al CFDI».");
  const enCurso = cargos.filter((c) => estadoFacturacion(c) === "EN_PREFACTURA");
  if (enCurso.length) throw new HospitalError(409, "Ya hay una prefactura que sustituye a esta factura: tímbrala o descártala.");

  const { items, sinClave } = conceptosDeCargos(cargos);
  if (sinClave.length) throw new HospitalError(422, `Falta la clave SAT de: ${sinClave.map((c) => `«${c.descripcion}»`).join(", ")}.`);
  const metodoPago = args.datos?.metodoPago ?? (vieja.metodoPago === "PPD" ? "PPD" : "PUE");
  const input: StampInput = {
    companyId: args.companyId,
    customerId: args.customerId ?? vieja.customerId!,
    formaPago: args.datos?.formaPago ?? vieja.formaPago ?? (metodoPago === "PPD" ? "99" : "03"),
    metodoPago,
    usoCfdi: args.datos?.usoCfdi ?? vieja.usoCfdi ?? "D01",
    notes: args.datos?.notes,
    items,
    relations: { relationship: "04", documents: [vieja.uuid] },
  };
  const r = await crearPrefactura(input, args.actor, args.req);
  if (r.status !== 201) return r;
  const prefacturaId = (r.body as { id: string }).id;
  const tomados = await prisma.hospCargo.updateMany({
    where: { id: { in: cargos.map((c) => c.id) }, invoiceId: vieja.id, cancelado: false, AND: [SIN_PREFACTURA_PENDIENTE] },
    data: { prefacturaId },
  });
  if (tomados.count !== cargos.length) {
    await liberarYDescartar(prefacturaId, args.actor, args.req);
    throw new HospitalError(409, "Cambiaron los cargos de esta factura mientras se armaba la sustitución. Vuelve a intentarlo.");
  }
  return r;
}
