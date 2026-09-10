// ─────────────────────────────────────────────────────────────────────────────
// Cobros de caja: el instrumento con el que el paciente paga.
//
// Un cobro NO es un depósito ni una factura. El depósito (`HospDeposito`) es
// anticipo y vive como pasivo hasta que se aplica; la factura es del hub. El
// cobro es el momento en que el dinero cambia de manos, y lo que interesa de
// él —además del monto— es CON QUÉ se pagó, porque de eso depende cuándo y
// cómo llega ese dinero al banco.
//
// La regla que ordena todo el archivo: EL MÓDULO NUNCA CARGA BANCOS. El
// efectivo entra a CAJA (101.01); tarjeta, transferencia y cheque entran a
// FONDOS EN TRÁNSITO (107.05) y ahí esperan. Quien los baja a bancos es el
// movimiento bancario conciliado en el hub. Si el cobro entrara directo a
// bancos, la misma cantidad se cargaría dos veces: al cobrar en caja y al
// llegar el depósito del adquirente.
//
// El candado de la terminal (`validarCobro`) existe porque un cobro con
// tarjeta sin afiliación, autorización, marca y últimos cuatro es un cobro que
// nadie va a poder casar contra el estado de cuenta del adquirente. Se exige
// al capturar, no al conciliar: para entonces ya no hay a quién preguntarle.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  HospCobroEstado,
  HospFormaPago,
  HospTarjetaMarca,
  HospTarjetaTipo,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import { asentarCobro } from "./asientos";
import { HospitalError } from "./errores";
import { claveDia, finDiaLocal, inicioDiaLocal } from "./tz";
import { r2 } from "./util";

type Db = PrismaClient | Prisma.TransactionClient;

export const FORMAS_PAGO_COBRO = ["EFECTIVO", "TRANSFERENCIA", "TARJETA", "CHEQUE"] as const;
export const MARCAS = ["VISA", "MASTERCARD", "AMEX", "CARNET", "OTRA"] as const;
export const TIPOS_TARJETA = ["CREDITO", "DEBITO"] as const;

/**
 * Un cobro nace COBRADO. De ahí sale por una de tres puertas: lo deposita el
 * adquirente, lo desconoce el tarjetahabiente, o se capturó mal.
 *
 * DEPOSITADO → CONTRACARGADO es un camino legítimo y es el caso que rompe el
 * cuadre: el contracargo llega semanas después de que el dinero ya entró, y el
 * adquirente lo descuenta del depósito de ESE día, no del original.
 */
export const TRANSICIONES_COBRO: Record<HospCobroEstado, HospCobroEstado[]> = {
  COBRADO: ["DEPOSITADO", "CONTRACARGADO", "CANCELADO"],
  DEPOSITADO: ["CONTRACARGADO"],
  CONTRACARGADO: ["RECUPERADO"],
  RECUPERADO: [],
  CANCELADO: [],
};

export function puedeTransicionar(desde: HospCobroEstado, hacia: HospCobroEstado): boolean {
  return TRANSICIONES_COBRO[desde].includes(hacia);
}

/** Estados en los que el cobro sigue representando dinero del hospital. */
export const ESTADOS_VIGENTES: HospCobroEstado[] = ["COBRADO", "DEPOSITADO", "RECUPERADO"];

export const esVigente = (estado: HospCobroEstado): boolean => ESTADOS_VIGENTES.includes(estado);

// ─── Captura ─────────────────────────────────────────────────────────────────

export interface CobroInput {
  fecha: Date;
  monto: number;
  formaPago: HospFormaPago;
  episodioId?: string | null;
  invoiceId?: string | null;
  depositoId?: string | null;
  afiliacionId?: string | null;
  autorizacion?: string | null;
  marca?: HospTarjetaMarca | null;
  tipoTarjeta?: HospTarjetaTipo | null;
  ultimos4?: string | null;
  referencia?: string | null;
  notas?: string | null;
}

export interface CobroValidado extends CobroInput {
  monto: number;
  autorizacion: string | null;
  ultimos4: string | null;
  referencia: string | null;
}

/**
 * La autorización del voucher. Lo común son seis dígitos, pero AMEX y algunas
 * terminales imprimen alfanumérico de otra longitud: se valida que EXISTA y
 * que sea plausible, no que tenga un formato que el adquirente no garantiza.
 * El candado que importa es el de presencia.
 */
export function normalizarAutorizacion(valor: unknown): string {
  const s = String(valor ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(s)) {
    throw new HospitalError(400, "La autorización del voucher son de 4 a 8 caracteres alfanuméricos.");
  }
  return s;
}

export function normalizarUltimos4(valor: unknown): string {
  const s = String(valor ?? "").trim();
  if (!/^\d{4}$/.test(s)) throw new HospitalError(400, "Los últimos cuatro dígitos de la tarjeta son exactamente cuatro números.");
  return s;
}

/**
 * El candado. Un cobro con tarjeta sin los datos de la terminal no se guarda:
 * es el que después aparece en el estado de cuenta del adquirente sin dueño.
 * Y todo cobro tiene que decir a qué entra —episodio, factura o anticipo—,
 * porque el cobro que no lo dice es justo el que no se puede explicar al corte.
 */
export function validarCobro(input: CobroInput): CobroValidado {
  const monto = r2(Number(input.monto));
  if (!(monto > 0)) throw new HospitalError(400, "El monto del cobro tiene que ser mayor que cero.");
  if (!(input.fecha instanceof Date) || Number.isNaN(input.fecha.getTime())) {
    throw new HospitalError(400, "El cobro necesita la fecha de operación del voucher.");
  }
  if (!input.episodioId && !input.invoiceId && !input.depositoId) {
    throw new HospitalError(400, "El cobro tiene que ir a un episodio, a una factura o a un anticipo.");
  }

  if (input.formaPago === "TARJETA") {
    if (!input.afiliacionId) throw new HospitalError(400, "Un cobro con tarjeta necesita la afiliación de la terminal.");
    if (!input.marca) throw new HospitalError(400, "Un cobro con tarjeta necesita la marca (VISA, MASTERCARD, AMEX…).");
    if (!input.tipoTarjeta) throw new HospitalError(400, "Un cobro con tarjeta necesita decir si es crédito o débito: el adquirente los liquida con tasas distintas.");
    return {
      ...input,
      monto,
      autorizacion: normalizarAutorizacion(input.autorizacion),
      ultimos4: normalizarUltimos4(input.ultimos4),
      referencia: input.referencia?.trim() || null,
    };
  }

  // Sin tarjeta no hay terminal: los campos del voucher se limpian en vez de
  // guardarse a medias, para que la llave de conciliación no tenga basura.
  return {
    ...input,
    monto,
    afiliacionId: null,
    autorizacion: null,
    marca: null,
    tipoTarjeta: null,
    ultimos4: null,
    referencia: input.referencia?.trim() || null,
  };
}

// ─── La llave de conciliación ────────────────────────────────────────────────

/**
 * (afiliación, día de operación, monto, autorización).
 *
 * La autorización sola NO es llave: son pocos dígitos y el adquirente los
 * recicla entre días y entre afiliaciones. Los cuatro campos juntos sí
 * identifican la línea del estado de cuenta, que es contra lo que hay que
 * cuadrar. Se usa el DÍA local, no el instante: caja teclea el lunes lo del
 * sábado y el adquirente reporta por día de operación.
 */
export function llaveCobro(c: {
  afiliacionId?: string | null;
  fecha: Date;
  monto: number | { toString(): string };
  autorizacion?: string | null;
}): string | null {
  if (!c.afiliacionId || !c.autorizacion) return null;
  return [c.afiliacionId, claveDia(c.fecha), r2(Number(c.monto)).toFixed(2), c.autorizacion].join("|");
}

/**
 * El cobro que ya está capturado con la misma llave. Caja recaptura por
 * nervios más seguido de lo que parece, y un cobro duplicado infla el bruto
 * del día y deja la liquidación sin cuadrar por el monto exacto del duplicado.
 * Los CANCELADOS no cuentan: para eso se cancelan.
 */
export async function buscarDuplicado(
  db: Db,
  companyId: string,
  c: { afiliacionId?: string | null; fecha: Date; monto: number; autorizacion?: string | null }
): Promise<{ id: string } | null> {
  if (!c.afiliacionId || !c.autorizacion) return null;
  return db.hospCobro.findFirst({
    where: {
      companyId,
      afiliacionId: c.afiliacionId,
      autorizacion: c.autorizacion,
      monto: r2(c.monto),
      fecha: { gte: inicioDiaLocal(c.fecha), lte: finDiaLocal(c.fecha) },
      estado: { not: "CANCELADO" },
    },
    select: { id: true },
  });
}

// ─── Corte de caja ───────────────────────────────────────────────────────────

export interface CorteCaja {
  efectivo: number;
  transferencia: number;
  tarjeta: number;
  cheque: number;
  /** Lo cobrado y vigente: lo que caja debe poder entregar o explicar. */
  total: number;
  /** Lo que se cayó por contracargo. Se informa aparte; no resta del total. */
  contracargos: number;
  /** El efectivo es lo único que caja entrega en mano al cierre del turno. */
  enCaja: number;
  /** Tarjeta + transferencia + cheque: en tránsito hasta que el banco lo deposite. */
  enTransito: number;
}

type CobroParaCorte = {
  monto: number | { toString(): string };
  formaPago: HospFormaPago;
  estado: HospCobroEstado;
};

export function corteDeCaja(cobros: CobroParaCorte[]): CorteCaja {
  const suma = (fp: HospFormaPago) =>
    r2(cobros.filter((c) => c.formaPago === fp && esVigente(c.estado)).reduce((s, c) => s + Number(c.monto), 0));

  const efectivo = suma("EFECTIVO");
  const transferencia = suma("TRANSFERENCIA");
  const tarjeta = suma("TARJETA");
  const cheque = suma("CHEQUE");
  const contracargos = r2(
    cobros.filter((c) => c.estado === "CONTRACARGADO").reduce((s, c) => s + Number(c.monto), 0)
  );

  return {
    efectivo,
    transferencia,
    tarjeta,
    cheque,
    total: r2(efectivo + transferencia + tarjeta + cheque),
    contracargos,
    enCaja: efectivo,
    enTransito: r2(transferencia + tarjeta + cheque),
  };
}

// ─── Serialización ───────────────────────────────────────────────────────────

export function cobroResumen(c: {
  id: string;
  fecha: Date;
  monto: number | { toString(): string };
  formaPago: HospFormaPago;
  estado: HospCobroEstado;
  episodioId: string | null;
  invoiceId: string | null;
  depositoId: string | null;
  afiliacionId: string | null;
  autorizacion: string | null;
  marca: HospTarjetaMarca | null;
  tipoTarjeta: HospTarjetaTipo | null;
  ultimos4: string | null;
  referencia: string | null;
  liquidacionId: string | null;
  depositadoAt: Date | null;
  contracargoAt: Date | null;
  contracargoMotivo: string | null;
  recuperadoAt: Date | null;
  asientoAt: Date | null;
  notas: string | null;
  createdAt: Date;
}) {
  return {
    id: c.id,
    fecha: c.fecha,
    monto: r2(Number(c.monto)),
    formaPago: c.formaPago,
    estado: c.estado,
    episodioId: c.episodioId,
    invoiceId: c.invoiceId,
    depositoId: c.depositoId,
    afiliacionId: c.afiliacionId,
    autorizacion: c.autorizacion,
    marca: c.marca,
    tipoTarjeta: c.tipoTarjeta,
    ultimos4: c.ultimos4,
    referencia: c.referencia,
    liquidacionId: c.liquidacionId,
    depositadoAt: c.depositadoAt,
    contracargoAt: c.contracargoAt,
    contracargoMotivo: c.contracargoMotivo,
    recuperadoAt: c.recuperadoAt,
    asientoAt: c.asientoAt,
    notas: c.notas,
    createdAt: c.createdAt,
  };
}

// ─── Escritura ───────────────────────────────────────────────────────────────

export interface CrearCobroArgs extends CobroInput {
  companyId: string;
  usuarioId?: string | null;
  /** Deja pasar una recaptura que el cajero confirmó a propósito. */
  permitirDuplicado?: boolean;
}

export async function crearCobro(db: PrismaClient, args: CrearCobroArgs) {
  const v = validarCobro(args);

  return db.$transaction(async (tx) => {
    let folio: string | null = null;
    if (v.episodioId) {
      const ep = await tx.hospEpisodio.findUnique({ where: { id: v.episodioId }, select: { companyId: true, folio: true, estado: true } });
      if (!ep || ep.companyId !== args.companyId) throw new HospitalError(404, "Episodio no encontrado");
      if (ep.estado === "CANCELADO") throw new HospitalError(409, `El episodio ${ep.folio} está cancelado: no recibe cobros`);
      folio = ep.folio;
    }
    if (v.afiliacionId) {
      const af = await tx.hospAfiliacion.findUnique({ where: { id: v.afiliacionId }, select: { companyId: true, activa: true, numero: true } });
      if (!af || af.companyId !== args.companyId) throw new HospitalError(404, "Afiliación no encontrada");
      if (!af.activa) throw new HospitalError(409, `La afiliación ${af.numero} está dada de baja: no debería estar cobrando en esa terminal`);
    }
    if (v.depositoId) {
      const dep = await tx.hospDeposito.findUnique({ where: { id: v.depositoId }, select: { companyId: true, monto: true } });
      if (!dep || dep.companyId !== args.companyId) throw new HospitalError(404, "Anticipo no encontrado");
    }

    if (!args.permitirDuplicado) {
      const dup = await buscarDuplicado(tx, args.companyId, { afiliacionId: v.afiliacionId, fecha: v.fecha, monto: v.monto, autorizacion: v.autorizacion });
      if (dup) {
        throw new HospitalError(
          409,
          "Ya hay un cobro capturado con la misma afiliación, fecha, monto y autorización. Si de verdad son dos cobros distintos, confírmalo."
        );
      }
    }

    const cobro = await tx.hospCobro.create({
      data: {
        companyId: args.companyId,
        fecha: v.fecha,
        monto: v.monto,
        formaPago: v.formaPago,
        episodioId: v.episodioId ?? null,
        invoiceId: v.invoiceId ?? null,
        depositoId: v.depositoId ?? null,
        afiliacionId: v.afiliacionId ?? null,
        autorizacion: v.autorizacion,
        marca: v.marca ?? null,
        tipoTarjeta: v.tipoTarjeta ?? null,
        ultimos4: v.ultimos4,
        referencia: v.referencia,
        notas: v.notas?.trim() || null,
        cobradoPorUserId: args.usuarioId ?? null,
      },
    });
    // ── Contabilidad (P3c): CAJA/FONDOS_EN_TRANSITO contra CLIENTES, si está activa.
    //    El cobro ligado a un anticipo no asienta: ya lo asentó el depósito.
    await asentarCobro(tx, { ...cobro, folio });
    return tx.hospCobro.findUniqueOrThrow({ where: { id: cobro.id } });
  });
}

export interface CambiarEstadoCobroArgs {
  companyId: string;
  cobroId: string;
  estado: HospCobroEstado;
  /** Fecha del hecho (contracargo o recuperación); default ahora. */
  fecha?: Date | null;
  motivo?: string | null;
  ahora?: Date;
}

export async function cambiarEstadoCobro(db: PrismaClient, args: CambiarEstadoCobroArgs) {
  const ahora = args.ahora ?? new Date();
  const fecha = args.fecha ?? ahora;
  if (Number.isNaN(fecha.getTime())) throw new HospitalError(400, "Fecha inválida");

  return db.$transaction(async (tx) => {
    const cobro = await tx.hospCobro.findUnique({ where: { id: args.cobroId }, include: { episodio: { select: { folio: true } } } });
    if (!cobro || cobro.companyId !== args.companyId) throw new HospitalError(404, "Cobro no encontrado");
    if (!puedeTransicionar(cobro.estado, args.estado)) {
      throw new HospitalError(409, `El cobro está ${cobro.estado}; de ahí no pasa a ${args.estado}`);
    }
    if (fecha.getTime() < cobro.fecha.getTime()) throw new HospitalError(400, "La fecha no puede ser anterior a la del cobro");
    if (args.estado === "DEPOSITADO") {
      throw new HospitalError(409, "Un cobro se marca depositado al armar la liquidación del adquirente, no uno por uno.");
    }

    const actualizado = await tx.hospCobro.update({
      where: { id: cobro.id },
      data: {
        estado: args.estado,
        ...(args.estado === "CONTRACARGADO" ? { contracargoAt: fecha, contracargoMotivo: args.motivo?.trim() || null } : {}),
        ...(args.estado === "RECUPERADO" ? { recuperadoAt: fecha } : {}),
      },
    });
    await asentarCobro(tx, { ...actualizado, folio: cobro.episodio?.folio ?? null }, { ahora: fecha });
    return tx.hospCobro.findUniqueOrThrow({ where: { id: cobro.id } });
  });
}

export function afiliacionResumen(a: {
  id: string;
  numero: string;
  descripcion: string | null;
  adquirente: string | null;
  activa: boolean;
  tasa: number | { toString(): string } | null;
  liquidaEnBruto: boolean;
  createdAt: Date;
  _count?: { cobros?: number };
}) {
  return {
    id: a.id,
    numero: a.numero,
    descripcion: a.descripcion,
    adquirente: a.adquirente,
    activa: a.activa,
    tasa: a.tasa == null ? null : Number(a.tasa),
    liquidaEnBruto: a.liquidaEnBruto,
    cobros: a._count?.cobros ?? null,
    createdAt: a.createdAt,
  };
}

// ─── Lo que 107.05 debe, para la conciliación bancaria ───────────────────────

export interface FondoEnTransito {
  id: string;
  origen: "COBRO" | "DEPOSITO";
  fecha: Date;
  monto: number;
  formaPago: HospFormaPago;
  afiliacionId: string | null;
}

export interface FondosEnTransito {
  saldo: number;
  /** En FIFO por fecha: el orden en que la conciliación los va cubriendo. */
  cobros: FondoEnTransito[];
}

/**
 * El saldo de FONDOS_EN_TRANSITO (107.05) y los cobros que lo componen, hasta
 * una fecha. Lo consume la conciliación bancaria del hub para partir el abono
 * del depósito de terminal: 107.05 por lo que alcance a cubrir de lo pendiente
 * —en FIFO por fecha— y CLIENTES por el resto (lo cobrado antes de que el
 * hospital operara caja ya tenía su derecho de cobro creado por el CFDI).
 *
 * Vive aquí, y no en la conciliación, para que la regla de QUÉ cuenta como
 * pendiente tenga un solo dueño. Pendiente = se cargó a 107.05 y nadie lo ha
 * acreditado todavía:
 *
 *  · Cobro sin liquidación, o con una liquidación que aún no tiene su
 *    movimiento bancario. Una vez conciliada, el neto ya salió de 107.05 por
 *    el banco y la comisión por `planesLiquidacion`: deja de estar pendiente.
 *  · Depósito RECIBIDO o APLICADO. Aplicar mueve ANTICIPOS a CLIENTES y no
 *    toca 107.05; devolver sí lo acredita, y por eso DEVUELTO no cuenta.
 *
 * El efectivo nunca entra: va a CAJA, que el banco no ve.
 */
export async function fondosEnTransitoPendientes(db: Db, companyId: string, hasta: Date = new Date()): Promise<FondosEnTransito> {
  const noEfectivo = { not: "EFECTIVO" as const };

  const [cobros, depositos] = await Promise.all([
    db.hospCobro.findMany({
      where: {
        companyId,
        depositoId: null,
        formaPago: noEfectivo,
        fecha: { lte: hasta },
        estado: { in: ["COBRADO", "DEPOSITADO"] },
        OR: [{ liquidacionId: null }, { liquidacion: { bankTransactionId: null } }],
      },
      select: { id: true, fecha: true, monto: true, formaPago: true, afiliacionId: true },
    }),
    db.hospDeposito.findMany({
      where: { companyId, formaPago: noEfectivo, fecha: { lte: hasta }, estado: { in: ["RECIBIDO", "APLICADO"] } },
      select: { id: true, fecha: true, monto: true, formaPago: true },
    }),
  ]);

  const filas: FondoEnTransito[] = [
    ...cobros.map((c) => ({ id: c.id, origen: "COBRO" as const, fecha: c.fecha, monto: r2(Number(c.monto)), formaPago: c.formaPago, afiliacionId: c.afiliacionId })),
    ...depositos.map((d) => ({ id: d.id, origen: "DEPOSITO" as const, fecha: d.fecha, monto: r2(Number(d.monto)), formaPago: d.formaPago, afiliacionId: null })),
  ].sort((a, b) => a.fecha.getTime() - b.fecha.getTime());

  return { saldo: r2(filas.reduce((s, f) => s + f.monto, 0)), cobros: filas };
}
