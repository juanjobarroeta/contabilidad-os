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
      select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true },
    }),
    // El hub guarda la contraparte de TODO CFDI como Customer, en las dos
    // direcciones; `Supplier` es sólo datos de pago. El padrón es éste.
    db.customer.findMany({
      where: { companyId },
      select: { id: true, razonSocial: true, rfc: true, chartAccountId: true },
    }),
  ]);

  const yaLigados = contrapartes.filter((c) => c.chartAccountId).length;
  const libres = contrapartes.filter((c) => !c.chartAccountId);
  const tomadas = new Set(contrapartes.map((c) => c.chartAccountId).filter(Boolean) as string[]);

  const pares: Pareja[] = [];
  const sinPareja: SinPareja[] = [];
  // Una contraparte no puede quedar propuesta para dos auxiliares distintos.
  const propuestas = new Map<string, number>();

  for (const cta of cuentas) {
    const codigo = cta.subcuenta ?? cta.cuentaSAT;
    if (tomadas.has(cta.id)) continue;
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

  // Dos auxiliares que apuntan a la misma contraparte: ninguno se sostiene.
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
    const { count } = await db.customer.updateMany({
      // `companyId` en el where no es redundante: impide ligar la contraparte
      // de otra empresa a una cuenta de ésta.
      where: { id: p.customerId, companyId, chartAccountId: null },
      data: { chartAccountId: p.chartAccountId },
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
export async function cuentaDeContraparte(db: Db, companyId: string, customerId: string | null | undefined): Promise<string | null> {
  if (!customerId) return null;
  const c = await db.customer.findFirst({
    where: { id: customerId, companyId },
    select: { chartAccount: { select: { id: true, isActive: true } } },
  });
  return c?.chartAccount?.isActive ? c.chartAccount.id : null;
}
