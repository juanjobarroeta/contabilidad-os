// ─────────────────────────────────────────────────────────────────────────────
// Derivación de inventario de vehículos desde un CFDI (onboarding con la e.firma).
//
// El edge del producto, igual que auto-activo: "solo corre". Al sincronizar los
// CFDIs del SAT, cada factura que ampara un vehículo (complemento VentaVehiculos)
// construye/actualiza el inventario sin que nadie capture nada:
//   • COMPRA (EGRESO, la agencia es receptor) → crea la unidad DISPONIBLE con su
//     costo, liga el CFDI de compra y registra traslado/seguro como VehiculoCosto.
//   • VENTA  (INGRESO, la agencia es emisor)   → marca la unidad VENDIDO, liga el
//     CFDI de venta y su precio. Si la venta llega antes que la compra, crea la
//     unidad ya VENDIDA para no perderla (la compra posterior la enriquece).
//
// IMPORTANTE — no postea al mayor. El asiento contable del CFDI lo genera el
// cierre mensual (lib/contabilidad/posting.ts); este derivador SOLO construye la
// capa de inventario (Vehiculo / VehiculoCosto). Postear aquí duplicaría.
//
// Idempotente: por (companyId, vin) para la unidad, y por (vehiculoId, invoiceId)
// para los costos. Seguro de llamar siempre — mismo contrato que auto-activo.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  condicionesDePagoDesdeCfdi,
  datosGeneralesDesdeCfdi,
  diasCreditoDesdeCondiciones,
  emisorDesdeCfdi,
  extraerDatosVehiculoCfdi,
  marcaDesdeTexto,
  numeroMotorDesdeTexto,
  sustituyeUuidsDesdeCfdi,
  tipoComprobanteDesdeCfdi,
  tipoCostoDesdeConcepto,
} from "./vin";
import { normalizarUuid } from "@/lib/fiscal/uuid";
import { modeloLimpio } from "./claves";

type Db = PrismaClient | Prisma.TransactionClient;

export interface DerivarVehiculoArgs {
  companyId: string;
  invoiceId: string;
  /** Invoice.tipo — INGRESO = venta (agencia emite), EGRESO = compra (agencia recibe). */
  tipo: string;
  fecha: Date;
  rawXml: string | null;
  /** Proveedor canónico (emisor) en una compra, si el import ya lo resolvió. */
  supplierId?: string | null;
  /** Resolver perezoso del proveedor (find-or-create por RFC del emisor):
   *  se invoca UNA vez y sólo cuando de verdad se va a ligar una compra —
   *  así el backfill no crea Suppliers para gastos que no amparan unidades. */
  resolverSupplierId?: () => Promise<string | null>;
  /** Cliente canónico (receptor) en una venta, si el import ya lo resolvió. */
  clienteId?: string | null;
}

export interface DerivarVehiculoResultado {
  creados: number;
  actualizados: number;
  vins: string[];
}

/**
 * marca/modelo/versión/año para una unidad nueva: primero el catálogo de claves
 * vehiculares (Anexo 15 — autoritativo) vía la clave del complemento; si la
 * clave aún no está ingerida, la heurística de texto. En ambos casos la unidad
 * nace `autoCreado` y el distribuidor confirma.
 */
async function generalesParaUnidad(
  db: Db,
  v: { claveVehicular: string | null; descripcion: string | null; noIdentificacion: string | null },
  anioFallback: number
): Promise<{ marca: string; modelo: string; version: string | null; anio: number }> {
  const heur = datosGeneralesDesdeCfdi(v.descripcion, v.noIdentificacion, anioFallback);

  if (v.claveVehicular) {
    const cat = await db.claveVehicularCatalogo.findUnique({
      where: { clave: v.claveVehicular },
      select: { empresa: true, modelo: true, version: true },
    });
    if (cat) {
      return {
        marca:
          marcaDesdeTexto(`${cat.modelo} ${cat.version ?? ""}`) ??
          marcaDesdeTexto(cat.empresa) ??
          heur.marca ??
          cat.empresa.slice(0, 60),
        modelo: modeloLimpio(cat.modelo).slice(0, 60) || heur.modelo || "POR REVISAR",
        version: cat.version ? cat.version.slice(0, 80) : null,
        anio: heur.anio ?? anioFallback,
      };
    }
  }

  return {
    marca: heur.marca ?? "POR REVISAR",
    modelo: heur.modelo ?? "POR REVISAR",
    version: null,
    anio: heur.anio ?? anioFallback,
  };
}

/**
 * Deriva/actualiza el inventario de una factura. Devuelve null si el CFDI no
 * ampara vehículos o no hay rawXml para parsear.
 */
export async function derivarVehiculoDesdeCfdiSiAplica(
  db: Db,
  args: DerivarVehiculoArgs
): Promise<DerivarVehiculoResultado | null> {
  if (!args.rawXml) return null;

  const datos = extraerDatosVehiculoCfdi(args.rawXml);

  const esVenta = args.tipo === "INGRESO";
  const esCompra = args.tipo === "EGRESO";
  // Sólo compra/venta mueven inventario. TRASLADO/NOMINA/PAGO no aplican.
  if (!esVenta && !esCompra) return null;

  // Nota de crédito (TipoDeComprobante "E"): un rebate/descuento del proveedor
  // que referencia la unidad NETEA su costo (VehiculoCosto negativo) — jamás
  // crea ni vende unidades. Una nota de crédito emitida A un cliente (lado
  // INGRESO) no toca inventario.
  if (tipoComprobanteDesdeCfdi(args.rawXml) === "E") {
    if (!esCompra) return null;
    let actualizadosNc = 0;
    const vinsNc: string[] = [];
    const referencias = [
      ...datos.vehiculos.map((v) => ({ niv: v.niv, descripcion: v.descripcion, importe: v.importe })),
      ...datos.otrosConceptos
        .filter((c) => c.nivRef)
        .map((c) => ({ niv: c.nivRef!, descripcion: c.descripcion, importe: c.importe })),
    ];
    if (referencias.length === 0) return null;
    for (const [niv, items] of agrupa(referencias)) {
      const unidad = await db.vehiculo.findUnique({
        where: { companyId_vin: { companyId: args.companyId, vin: niv } },
        select: { id: true },
      });
      if (!unidad) continue;
      await registrarMencion(db, unidad.id, args.invoiceId, "NOTA_CREDITO");
      const agrego = await registrarNotaCredito(db, unidad.id, args, items);
      if (agrego) {
        actualizadosNc++;
        vinsNc.push(niv);
      }
    }
    return { creados: 0, actualizados: actualizadosNc, vins: vinsNc };
  }

  // INGRESO que sólo MENCIONA VINs sin amparar unidades (taller/servicio):
  // no toca inventario, pero sí queda en el expediente del VIN.
  if (esVenta && datos.vehiculos.length === 0) {
    const nivsServicio = [...new Set(datos.otrosConceptos.filter((c) => c.nivRef).map((c) => c.nivRef!))];
    for (const niv of nivsServicio) {
      const unidad = await db.vehiculo.findUnique({
        where: { companyId_vin: { companyId: args.companyId, vin: niv } },
        select: { id: true },
      });
      if (unidad) await registrarMencion(db, unidad.id, args.invoiceId, "SERVICIO");
    }
    return null;
  }

  // Costos de la unidad facturados APARTE de la compra (flete, seguro,
  // accesorios que mencionan el VIN): se atribuyen a la unidad existente.
  // Sólo en gastos — un INGRESO que menciona un VIN sin ser la unidad es
  // ingreso de taller/servicio, no toca inventario.
  const vinsDelCfdi = new Set(datos.vehiculos.map((v) => v.niv));
  const costosExternos = esCompra
    ? datos.otrosConceptos.filter((c) => c.nivRef && !vinsDelCfdi.has(c.nivRef))
    : [];

  if (datos.vehiculos.length === 0 && costosExternos.length === 0) return null;

  const anioFallback = args.fecha.getUTCFullYear();
  let creados = 0;
  let actualizados = 0;
  const vins: string[] = [];

  // Proveedor: el valor explícito gana; si no, el resolver perezoso (memoizado).
  let supplierMemo: string | null | undefined = args.supplierId;
  const supplierId = async (): Promise<string | null> => {
    if (supplierMemo === undefined) {
      supplierMemo = (await args.resolverSupplierId?.()) ?? null;
    }
    return supplierMemo;
  };

  for (const v of datos.vehiculos) {
    vins.push(v.niv);
    const existente = await db.vehiculo.findUnique({
      where: { companyId_vin: { companyId: args.companyId, vin: v.niv } },
      select: {
        id: true,
        estado: true,
        compraInvoiceId: true,
        ventaInvoiceId: true,
        supplierId: true,
        clienteId: true,
        autoCreado: true,
        marca: true,
        modelo: true,
        numeroMotor: true,
      },
    });

    // Número de motor: si la unidad no lo tiene y este CFDI lo menciona,
    // se completa (misma filosofía que cliente/proveedor faltantes).
    if (existente && !existente.numeroMotor) {
      const nm = numeroMotorDesdeTexto(v.descripcion) ?? numeroMotorDesdeTexto(v.noIdentificacion);
      if (nm) {
        await db.vehiculo.update({ where: { id: existente.id }, data: { numeroMotor: nm } });
        actualizados++;
      }
    }

    // Reparación de generales: una unidad auto-creada cuando el catálogo de
    // claves aún no estaba ingerido quedó "POR REVISAR". Si la clave ya está en
    // el catálogo (o la heurística hoy da algo mejor), se re-nombra. Nunca toca
    // unidades editadas a mano (autoCreado=false).
    if (
      existente?.autoCreado &&
      (existente.marca === "POR REVISAR" || existente.modelo === "POR REVISAR")
    ) {
      const g = await generalesParaUnidad(db, v, anioFallback);
      if (
        (g.marca !== "POR REVISAR" && g.marca !== existente.marca) ||
        (g.modelo !== "POR REVISAR" && g.modelo !== existente.modelo)
      ) {
        await db.vehiculo.update({
          where: { id: existente.id },
          data: { marca: g.marca, modelo: g.modelo, version: g.version ?? undefined },
        });
        actualizados++;
      }
    }

    if (esCompra) {
      if (existente) {
        // Idempotente: si ya tiene su CFDI de compra, no re-procesar. Pero si a
        // la primera pasada le faltó el proveedor (se resolvió después), una
        // re-corrida lo completa sin tocar nada más.
        if (existente.compraInvoiceId) {
          if (existente.compraInvoiceId === args.invoiceId) {
            await registrarMencion(db, existente.id, args.invoiceId, "COMPRA");
            if (!existente.supplierId) {
              const s = await supplierId();
              if (s) {
                await db.vehiculo.update({ where: { id: existente.id }, data: { supplierId: s } });
                if (args.rawXml) await registrarTermsProveedor(db, s, args.rawXml);
                actualizados++;
              }
            }
            continue;
          }
          // Refactura (TipoRelacion 04): este CFDI sustituye al ligado — la
          // compra vigente es ÉSTA aunque la cancelación no esté marcada aún.
          if (await sustituyeAlLigado(db, args.rawXml, existente.compraInvoiceId)) {
            await db.vehiculoCosto.deleteMany({
              where: { vehiculoId: existente.id, invoiceId: existente.compraInvoiceId },
            });
            const sSust = await supplierId();
            await db.vehiculo.update({
              where: { id: existente.id },
              data: {
                compraInvoiceId: args.invoiceId,
                costoCompra: v.importe,
                fechaCompra: args.fecha,
                supplierId: sSust ?? undefined,
                claveVehicular: v.claveVehicular ?? undefined,
              },
            });
            await registrarMencion(db, existente.id, existente.compraInvoiceId, "SUSTITUIDA");
            await registrarMencion(db, existente.id, args.invoiceId, "COMPRA");
            actualizados++;
            await registrarCostosCompra(db, existente.id, args, costosDeUnidad(datos, v.niv));
            continue;
          }
          // Mismo VIN, sin relación 04, y la unidad ya tiene su compra: queda
          // en el expediente como DUPLICADA (auditable, no liga).
          await registrarMencion(db, existente.id, args.invoiceId, "DUPLICADA");
          continue;
        }
        const supLiga = await supplierId();
        if (supLiga && args.rawXml) await registrarTermsProveedor(db, supLiga, args.rawXml);
        await registrarMencion(db, existente.id, args.invoiceId, "COMPRA");
        await db.vehiculo.update({
          where: { id: existente.id },
          data: {
            compraInvoiceId: args.invoiceId,
            costoCompra: v.importe,
            fechaCompra: args.fecha,
            supplierId: supLiga ?? undefined,
            claveVehicular: v.claveVehicular ?? undefined,
            descripcionCfdi: v.descripcion ?? undefined,
          },
        });
        actualizados++;
        await registrarCostosCompra(db, existente.id, args, costosDeUnidad(datos, v.niv));
        continue;
      }
      const g = await generalesParaUnidad(db, v, anioFallback);
      const supNuevo = await supplierId();
      if (supNuevo && args.rawXml) await registrarTermsProveedor(db, supNuevo, args.rawXml);
      const creado = await db.vehiculo.create({
        data: {
          companyId: args.companyId,
          vin: v.niv,
          marca: g.marca,
          modelo: g.modelo,
          version: g.version,
          anio: g.anio,
          tipo: "NUEVO",
          estado: "DISPONIBLE",
          costoCompra: v.importe,
          fechaCompra: args.fecha,
          compraInvoiceId: args.invoiceId,
          supplierId: supNuevo,
          numeroMotor: numeroMotorDesdeTexto(v.descripcion) ?? numeroMotorDesdeTexto(v.noIdentificacion),
          claveVehicular: v.claveVehicular ?? null,
          descripcionCfdi: v.descripcion ?? null,
          autoCreado: true,
        },
        select: { id: true },
      });
      creados++;
      await registrarMencion(db, creado.id, args.invoiceId, "COMPRA");
      await registrarCostosCompra(db, creado.id, args, costosDeUnidad(datos, v.niv));
      continue;
    }

    // esVenta
    if (existente) {
      // Idempotente; igual que en compra, una re-corrida completa el cliente si
      // al derivar la venta el CFDI aún no tenía Customer ligado.
      if (existente.ventaInvoiceId) {
        if (existente.ventaInvoiceId === args.invoiceId) {
          await registrarMencion(db, existente.id, args.invoiceId, "VENTA");
          if (args.clienteId && !existente.clienteId) {
            await db.vehiculo.update({ where: { id: existente.id }, data: { clienteId: args.clienteId } });
            actualizados++;
          }
          continue;
        }
        // Refactura (TipoRelacion 04): esta venta sustituye a la ligada — el
        // precio/cliente vigentes son los de ÉSTA (la anterior quedó muerta).
        if (await sustituyeAlLigado(db, args.rawXml, existente.ventaInvoiceId)) {
          await db.vehiculo.update({
            where: { id: existente.id },
            data: {
              estado: "VENDIDO",
              precioVenta: v.importe,
              ventaInvoiceId: args.invoiceId,
              fechaVenta: args.fecha,
              clienteId: args.clienteId ?? undefined,
            },
          });
          await registrarMencion(db, existente.id, existente.ventaInvoiceId, "SUSTITUIDA");
          await registrarMencion(db, existente.id, args.invoiceId, "VENTA");
          actualizados++;
          continue;
        }
        // Mismo VIN, sin relación 04 (p. ej. factura a la financiera): expediente.
        await registrarMencion(db, existente.id, args.invoiceId, "DUPLICADA");
        continue;
      }
      await db.vehiculo.update({
        where: { id: existente.id },
        data: {
          estado: "VENDIDO",
          precioVenta: v.importe,
          ventaInvoiceId: args.invoiceId,
          fechaVenta: args.fecha,
          clienteId: args.clienteId ?? undefined,
        },
      });
      await registrarMencion(db, existente.id, args.invoiceId, "VENTA");
      actualizados++;
      continue;
    }
    // Venta sin compra previa: crea la unidad ya VENDIDA para no perderla.
    const g = await generalesParaUnidad(db, v, anioFallback);
    const creadoVenta = await db.vehiculo.create({
      data: {
        companyId: args.companyId,
        vin: v.niv,
        marca: g.marca,
        modelo: g.modelo,
        version: g.version,
        anio: g.anio,
        tipo: "NUEVO",
        estado: "VENDIDO",
        precioVenta: v.importe,
        ventaInvoiceId: args.invoiceId,
        fechaVenta: args.fecha,
        clienteId: args.clienteId ?? null,
        numeroMotor: numeroMotorDesdeTexto(v.descripcion) ?? numeroMotorDesdeTexto(v.noIdentificacion),
        claveVehicular: v.claveVehicular ?? null,
        descripcionCfdi: v.descripcion ?? null,
        autoCreado: true,
      },
      select: { id: true },
    });
    creados++;
    await registrarMencion(db, creadoVenta.id, args.invoiceId, "VENTA");
  }

  // Atribución de costos externos: flete/seguro/accesorios facturados aparte
  // que mencionan el VIN de una unidad ya en inventario. Idempotente por
  // (vehiculoId, invoiceId) — igual que los costos de la propia compra.
  for (const [niv, conceptos] of agrupaPorNiv(costosExternos)) {
    const unidad = await db.vehiculo.findUnique({
      where: { companyId_vin: { companyId: args.companyId, vin: niv } },
      select: { id: true },
    });
    if (!unidad) continue; // la unidad no es nuestra (o aún no llega su compra)
    await registrarMencion(db, unidad.id, args.invoiceId, "COSTO");
    const agrego = await registrarCostosCompra(db, unidad.id, args, conceptos);
    if (agrego) {
      actualizados++;
      if (!vins.includes(niv)) vins.push(niv);
    }
  }

  return { creados, actualizados, vins };
}

type MencionRol =
  | "COMPRA"
  | "VENTA"
  | "COSTO"
  | "NOTA_CREDITO"
  | "SUSTITUIDA"
  | "DUPLICADA"
  | "SERVICIO";

/**
 * Expediente CFDI del VIN: registra (upsert, idempotente) el papel de esta
 * factura para la unidad — incluidas las que NO ligan (duplicadas, sustituidas,
 * servicio), para que el expediente esté completo y auditable.
 */
async function registrarMencion(db: Db, vehiculoId: string, invoiceId: string, rol: MencionRol): Promise<void> {
  await db.vehiculoCfdi.upsert({
    where: { vehiculoId_invoiceId: { vehiculoId, invoiceId } },
    create: { vehiculoId, invoiceId, rol },
    update: { rol },
  });
}

/**
 * ¿Este CFDI sustituye (TipoRelacion 04) al invoice actualmente ligado?
 * Sólo consulta la base cuando el CFDI trae la relación — el caso común
 * (sin CfdiRelacionados) no cuesta nada.
 */
async function sustituyeAlLigado(db: Db, rawXml: string, invoiceIdLigado: string): Promise<boolean> {
  const sustituye = sustituyeUuidsDesdeCfdi(rawXml);
  if (sustituye.length === 0) return false;
  const ligado = await db.invoice.findUnique({
    where: { id: invoiceIdLigado },
    select: { uuid: true },
  });
  if (!ligado?.uuid) return false;
  const objetivo = normalizarUuid(ligado.uuid);
  return sustituye.some((u) => normalizarUuid(u) === objetivo);
}

/**
 * Términos del proveedor desde CondicionesDePago del CFDI de compra
 * ("CRÉDITO 30 DÍAS" → SupplierTerms.diasCredito=30). SOLO crea cuando el
 * proveedor no tiene términos — lo capturado a mano nunca se pisa.
 */
async function registrarTermsProveedor(db: Db, supplierId: string, rawXml: string): Promise<void> {
  const dias = diasCreditoDesdeCondiciones(condicionesDePagoDesdeCfdi(rawXml));
  if (dias == null) return;
  const ya = await db.supplierTerms.findUnique({ where: { supplierId }, select: { id: true } });
  if (ya) return;
  await db.supplierTerms.create({
    data: { supplierId, tieneCredito: dias > 0, diasCredito: dias },
  });
}

/** Proveedor canónico por el RFC del emisor del CFDI (find-or-create). */
export async function resolverSupplierDesdeEmisor(
  db: Db,
  companyId: string,
  rawXml: string
): Promise<string | null> {
  const emisor = emisorDesdeCfdi(rawXml);
  if (!emisor) return null;
  const s = await db.supplier.upsert({
    where: { companyId_rfc: { companyId, rfc: emisor.rfc } },
    create: { companyId, rfc: emisor.rfc, razonSocial: emisor.nombre ?? emisor.rfc },
    update: {},
    select: { id: true },
  });
  return s.id;
}

// Cache del gate de módulo para la derivación inline: el sync procesa miles de
// CFDIs por corrida y el módulo de una empresa casi nunca cambia.
const moduloCache = new Map<string, { habilitado: boolean; t: number }>();
const MODULO_TTL_MS = 5 * 60_000;

/**
 * Derivación INLINE (sat-sync / import-cfdi): igual que
 * derivarVehiculoDesdeCfdiSiAplica pero (a) sólo corre si la empresa tiene el
 * módulo AUTOMOTRIZ habilitado y (b) resuelve el proveedor por el emisor del
 * CFDI en compras. El cron vehiculos-backfill queda como red de seguridad.
 */
export async function derivarVehiculoInline(
  db: Db,
  args: DerivarVehiculoArgs
): Promise<DerivarVehiculoResultado | null> {
  const cached = moduloCache.get(args.companyId);
  let habilitado: boolean;
  if (cached && Date.now() - cached.t < MODULO_TTL_MS) {
    habilitado = cached.habilitado;
  } else {
    habilitado = !!(await db.companyModule.findFirst({
      where: { companyId: args.companyId, modulo: "AUTOMOTRIZ", habilitado: true },
      select: { id: true },
    }));
    moduloCache.set(args.companyId, { habilitado, t: Date.now() });
  }
  if (!habilitado) return null;

  const { rawXml, companyId } = args;
  return derivarVehiculoDesdeCfdiSiAplica(db, {
    ...args,
    resolverSupplierId:
      args.resolverSupplierId ??
      (args.tipo === "EGRESO" && rawXml
        ? () => resolverSupplierDesdeEmisor(db, companyId, rawXml)
        : undefined),
  });
}

type Otros = ReturnType<typeof extraerDatosVehiculoCfdi>["otrosConceptos"];

/**
 * Costos que van A la unidad `niv` dentro de la factura de compra: los que la
 * referencian por VIN y — sólo cuando la factura ampara UNA unidad — los que no
 * mencionan ninguno (en una factura multi-unidad un flete sin VIN es ambiguo y
 * atribuirlo a todas duplicaría el costo).
 */
function costosDeUnidad(datos: ReturnType<typeof extraerDatosVehiculoCfdi>, niv: string): Otros {
  return datos.otrosConceptos.filter(
    (c) => c.nivRef === niv || (c.nivRef == null && datos.vehiculos.length === 1)
  );
}

function agrupa<T extends { niv: string }>(items: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const arr = m.get(it.niv) ?? [];
    arr.push(it);
    m.set(it.niv, arr);
  }
  return m;
}

/**
 * Nota de crédito del proveedor sobre una unidad: cada concepto que la
 * referencia se registra como VehiculoCosto NEGATIVO (netea el costo).
 * Idempotente por (vehiculoId, invoiceId).
 */
async function registrarNotaCredito(
  db: Db,
  vehiculoId: string,
  args: DerivarVehiculoArgs,
  items: Array<{ descripcion: string | null; importe: number }>
): Promise<boolean> {
  const conMonto = items.filter((i) => i.importe > 0);
  if (conMonto.length === 0) return false;
  const yaHay = await db.vehiculoCosto.findFirst({
    where: { vehiculoId, invoiceId: args.invoiceId },
    select: { id: true },
  });
  if (yaHay) return false;
  await db.vehiculoCosto.createMany({
    data: conMonto.map((i) => ({
      vehiculoId,
      tipo: "OTRO" as const,
      concepto: `Nota de crédito: ${i.descripcion ?? "descuento del proveedor"}`,
      monto: -i.importe,
      fecha: args.fecha,
      invoiceId: args.invoiceId,
    })),
  });
  return true;
}

function agrupaPorNiv(otros: Otros): Map<string, Otros> {
  const m = new Map<string, Otros>();
  for (const c of otros) {
    if (!c.nivRef) continue;
    const arr = m.get(c.nivRef) ?? [];
    arr.push(c);
    m.set(c.nivRef, arr);
  }
  return m;
}

/**
 * Registra traslado/seguro/accesorios de una factura de compra como
 * VehiculoCosto. Idempotente por (vehiculoId, invoiceId): si ya hay costos de
 * ese CFDI en la unidad, no duplica.
 */
async function registrarCostosCompra(
  db: Db,
  vehiculoId: string,
  args: DerivarVehiculoArgs,
  otros: ReturnType<typeof extraerDatosVehiculoCfdi>["otrosConceptos"]
): Promise<boolean> {
  if (otros.length === 0) return false;
  const yaHay = await db.vehiculoCosto.findFirst({
    where: { vehiculoId, invoiceId: args.invoiceId },
    select: { id: true },
  });
  if (yaHay) return false;

  await db.vehiculoCosto.createMany({
    data: otros
      .filter((c) => c.importe > 0)
      .map((c) => ({
        vehiculoId,
        tipo: tipoCostoDesdeConcepto(c.claveProdServ, c.descripcion),
        concepto: c.descripcion ?? "Costo de la unidad",
        monto: c.importe,
        fecha: args.fecha,
        invoiceId: args.invoiceId,
      })),
  });
  return true;
}
