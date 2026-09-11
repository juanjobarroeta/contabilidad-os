// ─────────────────────────────────────────────────────────────────────────────
// Emparejar los auxiliares del catálogo propio con las contrapartes del padrón
// (docs/PLAN-motor-plan-propio.md → Fase 2i, paso 2).
//
// El catálogo que la empresa ya presentó al SAT trae un auxiliar por
// contraparte y LE PUSO SU NOMBRE: «2110-002-000 TELEFONOS DE MEXICO». El
// padrón del hub tiene a esa misma contraparte con su razón social, porque
// salió de un CFDI. Emparejarlos es lo que convierte «31 candidatas, elige
// una» —que no tiene respuesta— en «28 de 31 emparejados, revisa 3».
//
// DÓNDE VIVE EL ENLACE, que costó una migración corregirlo: en la CUENTA
// (`ChartAccount.customerId`), no en la contraparte. Un auxiliar pertenece a
// una sola contraparte, pero una contraparte tiene tantos auxiliares como
// papeles juegue — en BAOBAB, SUPERAVIT COMERCIALIZADORA es 2110-018 como
// proveedor, 2120-007 como acreedor y 1170-003 como deudor, las tres
// legítimas. Con el enlace del otro lado sólo cabía uno. El `codAgrup` de la
// cuenta ya dice para qué código sirve, así que (contraparte, código) queda
// determinado sin tabla intermedia.
//
// POR QUÉ ESTO PROPONE Y NO APLICA SOLO. Un enlace malo no se nota: manda el
// saldo de una contraparte a la cuenta de otra y la balanza sigue cuadrando,
// porque el importe está, sólo que en el renglón equivocado. Es el error más
// caro de todos —el que cuadra— así que:
//
//   · EXACTA (los nombres normalizados son idénticos) se puede aplicar sola.
//   · PARECIDA (`mismoNombre`: truncado del catálogo, una errata) se propone
//     y la confirma una persona.
//   · Si un auxiliar empata con DOS contrapartes, o dos auxiliares con la
//     misma, no se propone ninguna: ahí el nombre dejó de identificar.
//
// Medido en producción (2026-09-11) sobre 792 auxiliares de siete empresas:
// 48 % empareja sólo con nombre. BARTIZ 84 %, REYES HUERTA 64 %, ZIONX 62 %,
// SMP 47 %, TMA 33 %, MARGOM 0 % — y el 0 % de MARGOM es correcto: su catálogo
// es funcional («CXP PLANTA VEHICULOS»), no de contraparte, y ahí NO hay nada
// que emparejar. Que el número salga cero justo donde debe es la evidencia de
// que el método distingue las dos formas de catálogo.
// ─────────────────────────────────────────────────────────────────────────────

import type { Prisma, PrismaClient } from "@prisma/client";
import { mismoNombre, normalizarNombre } from "../bancos/nombres";
import { dimensionDe } from "./dimension-codigo";

type Db = PrismaClient | Prisma.TransactionClient;

export type Confianza = "EXACTA" | "PARECIDA";

export interface Pareja {
  chartAccountId: string;
  /** Como lo escribe el catálogo: «2110-002-000». */
  codigo: string;
  nombreCuenta: string;
  customerId: string;
  customerNombre: string;
  customerRfc: string;
  confianza: Confianza;
}

export interface SinPareja {
  chartAccountId: string;
  codigo: string;
  nombreCuenta: string;
  /** Por qué no se propuso nada: no hay a quién, o hay demasiados. */
  motivo: "sin_candidata" | "varias_candidatas";
}

export interface Emparejamiento {
  codigoMotor: string;
  pares: Pareja[];
  sinPareja: SinPareja[];
  /** Auxiliares que ya tienen contraparte ligada; no se vuelven a proponer. */
  yaLigados: number;
}

/** Nombres que un catálogo usa como relleno y que no son contrapartes. */
const NO_ES_CONTRAPARTE = [
  /^SALDO\s+INICIAL$/,
  /^PROVEEDOR(ES)?\s*#?$/,
  /^CLIENTE(S)?\s*#?$/,
  /^VARIOS$/,
  /^DIVERSOS$/,
  /^POR\s+(IDENTIFICAR|APLICAR|CLASIFICAR)$/,
];

export function esNombreDeRelleno(nombre: string): boolean {
  const n = normalizarNombre(nombre);
  return n.length === 0 || NO_ES_CONTRAPARTE.some((re) => re.test(n));
}

/**
 * Propone el emparejamiento de un código dimensional. Sólo lectura: no escribe
 * un solo enlace.
 */
export async function emparejarAuxiliares(db: Db, companyId: string, codigoMotor: string): Promise<Emparejamiento> {
  if (dimensionDe(codigoMotor).dimension !== "CONTRAPARTE") {
    return { codigoMotor, pares: [], sinPareja: [], yaLigados: 0 };
  }

  const [cuentas, contrapartes] = await Promise.all([
    db.chartAccount.findMany({
      where: { companyId, isActive: true, codAgrup: codigoMotor },
      select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true, customerId: true },
    }),
    // El hub guarda la contraparte de TODO CFDI como Customer, en las dos
    // direcciones; `Supplier` es sólo datos de pago. El padrón es éste.
    db.customer.findMany({
      where: { companyId },
      select: { id: true, razonSocial: true, rfc: true },
    }),
  ]);

  // Ya ligadas son las CUENTAS con contraparte; una contraparte puede estar en
  // varias cuentas a la vez (proveedor y acreedor) y eso no la agota.
  const yaLigados = cuentas.filter((c) => c.customerId).length;
  const libres = contrapartes;

  const pares: Pareja[] = [];
  const sinPareja: SinPareja[] = [];
  // Una contraparte no puede quedar propuesta para dos auxiliares distintos.
  const propuestas = new Map<string, number>();

  for (const cta of cuentas) {
    const codigo = cta.subcuenta ?? cta.cuentaSAT;
    if (cta.customerId) continue;
    if (esNombreDeRelleno(cta.nombre)) {
      sinPareja.push({ chartAccountId: cta.id, codigo, nombreCuenta: cta.nombre, motivo: "sin_candidata" });
      continue;
    }

    const n = normalizarNombre(cta.nombre);
    const exactas = libres.filter((c) => normalizarNombre(c.razonSocial) === n);
    const elegidas = exactas.length > 0 ? exactas : libres.filter((c) => mismoNombre(cta.nombre, c.razonSocial));

    if (elegidas.length === 0) {
      sinPareja.push({ chartAccountId: cta.id, codigo, nombreCuenta: cta.nombre, motivo: "sin_candidata" });
      continue;
    }
    if (elegidas.length > 1) {
      // El nombre dejó de identificar: proponer cualquiera sería adivinar.
      sinPareja.push({ chartAccountId: cta.id, codigo, nombreCuenta: cta.nombre, motivo: "varias_candidatas" });
      continue;
    }

    const c = elegidas[0];
    propuestas.set(c.id, (propuestas.get(c.id) ?? 0) + 1);
    pares.push({
      chartAccountId: cta.id,
      codigo,
      nombreCuenta: cta.nombre,
      customerId: c.id,
      customerNombre: c.razonSocial,
      customerRfc: c.rfc,
      confianza: exactas.length > 0 ? "EXACTA" : "PARECIDA",
    });
  }

  // Dos auxiliares del MISMO código apuntando a la misma contraparte: ninguno
  // se sostiene. Entre códigos distintos sí es legítimo —proveedor y acreedor
  // a la vez— y por eso esto se evalúa dentro de un solo código.
  const duplicadas = new Set([...propuestas.entries()].filter(([, n]) => n > 1).map(([id]) => id));
  if (duplicadas.size === 0) return { codigoMotor, pares, sinPareja, yaLigados };

  const buenos = pares.filter((p) => !duplicadas.has(p.customerId));
  for (const p of pares) {
    if (duplicadas.has(p.customerId)) {
      sinPareja.push({ chartAccountId: p.chartAccountId, codigo: p.codigo, nombreCuenta: p.nombreCuenta, motivo: "varias_candidatas" });
    }
  }
  return { codigoMotor, pares: buenos, sinPareja, yaLigados };
}

/**
 * Escribe los enlaces. `soloExactas` es el default: lo parecido lo confirma
 * una persona, porque un enlace malo cuadra igual y no se nota.
 */
export async function aplicarParejas(
  db: Db,
  companyId: string,
  pares: Pareja[],
  opts: { soloExactas?: boolean } = {}
): Promise<number> {
  const aplicar = opts.soloExactas === false ? pares : pares.filter((p) => p.confianza === "EXACTA");
  let n = 0;
  for (const p of aplicar) {
    const { count } = await db.chartAccount.updateMany({
      // `companyId` en el where no es redundante: impide ligar una cuenta de
      // otra empresa. `customerId: null` hace la escritura idempotente y no
      // pisa un enlace que alguien ya corrigió a mano.
      where: { id: p.chartAccountId, companyId, customerId: null },
      data: { customerId: p.customerId },
    });
    n += count;
  }
  return n;
}

/**
 * La cuenta auxiliar de una contraparte, o null si todavía no tiene.
 *
 * Null significa «cae a la cuenta base», que es exactamente lo que el motor
 * hace hoy para estos códigos: adoptar esto no mueve nada hasta que hay enlace.
 */
export async function cuentaDeContraparte(
  db: Db,
  companyId: string,
  codigoMotor: string,
  customerId: string | null | undefined
): Promise<string | null> {
  if (!customerId) return null;
  const cta = await db.chartAccount.findFirst({
    where: { companyId, isActive: true, codAgrup: codigoMotor, customerId },
    select: { id: true },
  });
  return cta?.id ?? null;
}

// ─── Resolución en el posteo ─────────────────────────────────────────────────

/** `${codAgrup}|${customerId}` → id de la cuenta auxiliar. */
export type IndiceAuxiliares = ReadonlyMap<string, string>;

const llave = (codigoMotor: string, customerId: string) => `${codigoMotor}|${customerId}`;

/**
 * Todos los auxiliares ligados de la empresa, en UNA consulta.
 *
 * El posteo resuelve una vez por código al arrancar el mes; la contraparte
 * cambia en cada comprobante. Preguntar por comprobante sería una consulta por
 * renglón dentro del bucle del mes — así que se carga el índice completo antes
 * de entrar. Una empresa con 400 auxiliares son 400 filas de tres columnas.
 */
export async function cargarAuxiliaresPorContraparte(db: Db, companyId: string): Promise<IndiceAuxiliares> {
  const filas = await db.chartAccount.findMany({
    where: { companyId, isActive: true, customerId: { not: null } },
    select: { id: true, codAgrup: true, customerId: true },
  });
  const idx = new Map<string, string>();
  for (const f of filas) {
    if (f.codAgrup && f.customerId) idx.set(llave(f.codAgrup, f.customerId), f.id);
  }
  return idx;
}

/** El auxiliar de esta contraparte para este código, o null si no hay. PURA. */
export function cuentaAuxiliar(idx: IndiceAuxiliares, codigoMotor: string, customerId: string | null | undefined): string | null {
  if (!customerId) return null;
  return idx.get(llave(codigoMotor, customerId)) ?? null;
}

/**
 * La contraparte que comparten las facturas de un pago, o null si no hay una
 * sola.
 *
 * Un movimiento bancario puede liquidar varias facturas, y el motor las abona
 * en UN renglón. Si esas facturas son de contrapartes distintas, no existe un
 * auxiliar que sea el correcto: se cae a la cuenta base, que es lo que se hace
 * hoy. Mismo criterio que `kindComun` — de hecho es la misma forma: o todos
 * coinciden, o no se decide.
 */
export function contraparteComun(
  customerPorInvoice: ReadonlyMap<string, string | null>,
  invoiceIds: string[],
): string | null {
  if (invoiceIds.length === 0) return null;
  const primero = customerPorInvoice.get(invoiceIds[0]) ?? null;
  if (primero == null) return null;
  return invoiceIds.every((id) => customerPorInvoice.get(id) === primero) ? primero : null;
}
