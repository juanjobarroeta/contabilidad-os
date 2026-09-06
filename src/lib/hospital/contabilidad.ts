// ─────────────────────────────────────────────────────────────────────────────
// Mapa de cuentas del módulo HOSPITAL (docs/HOSPITAL.md → P3 «Contabilidad»).
//
// El motor del hospital no habla de cuentas sino de CLAVES: la pierna de un
// CFDI es «INGRESO_QUIROFANO», la salida de farmacia carga «COSTO_FARMACIA».
// Aquí vive la tabla clave → cuenta con tres capas, de la más general a la
// decisión del contador:
//
//   DEFAULT   el código agrupador del SAT que corresponde a la clave
//             (401.01 ingresos gravados, 205.06 acreedores diversos…).
//   CONFIG    `HospConfig.cuentasContables[clave] = { cuentaSAT, subcuenta? }`:
//             el contador cambió el código (p. ej. 401.03 «a crédito») o señaló
//             una cuenta concreta de su propio plan (`subcuenta`).
//   OVERRIDE  `PostingCuentaOverride` con codigoMotor `hospital:<clave>` →
//             una ChartAccount exacta. Es lo que guarda PUT /contabilidad/mapa
//             cuando la cuenta señalada existe en el catálogo de la empresa.
//
// Después de las tres capas, el código se resuelve como lo hace el hub
// (seed-catalog.resolveAccount): override del contador para ese código,
// inversión codAgrup → cuenta PROPIA cuando es única, la cuenta del catálogo
// con ese código, o se crea desde el catálogo (starter, extras, las del
// hospital o el agrupador oficial). Todo con el cliente que se recibe, para
// que corra dentro de la transacción del evento.
//
// Por qué no `getOrCreateAccount` de accounting/postings.ts: ese helper sólo
// conoce códigos de cuatro dígitos («1101», «4101») y busca `subcuenta: null`;
// con «401.01» lanzaría (no está en DEFAULT_ACCOUNTS) y, si se agregara,
// crearía una fila paralela a la «401 / 401.01» que siembra el catálogo del
// SAT, partiendo el saldo en dos cuentas. Las cuentas del hospital son
// agrupadores del SAT, así que se resuelven como los del motor.
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountType, HospCargoCategoria, HospIvaContexto, Prisma, PrismaClient } from "@prisma/client";
import { SAT_STARTER_CATALOG, type CatalogAccount } from "../contabilidad/catalog";
import { EXTRA_ACCOUNTS_FOR_CLASSIFICATION } from "../contabilidad/classify-egreso";
import { CODIGO_AGRUPADOR_OFICIAL } from "../contabilidad/codigo-agrupador";
import { naturalezaPorTipo } from "../contabilidad/coe-saldos";
import { HospitalError } from "./errores";

type Db = PrismaClient | Prisma.TransactionClient;

export const CLAVES_MOTOR = [
  "INGRESO_HOSPITALIZACION",
  "INGRESO_QUIROFANO",
  "INGRESO_URGENCIAS",
  "INGRESO_ESTUDIOS",
  "INGRESO_FARMACIA_16",
  "INGRESO_FARMACIA_0",
  "INGRESO_MATERIAL",
  "INGRESO_OTROS",
  "HONORARIOS_POR_CUENTA_DE_TERCEROS",
  "RETENCION_ISR_HONORARIOS",
  "RETENCION_IVA_HONORARIOS",
  "COSTO_FARMACIA",
  "INVENTARIO_FARMACIA",
  "ANTICIPOS_PACIENTES",
  "CAJA",
  "BANCOS",
  "CLIENTES",
] as const;

export type ClaveMotor = (typeof CLAVES_MOTOR)[number];

export interface DefinicionClave {
  clave: ClaveMotor;
  descripcion: string;
  /** Código agrupador del SAT por default. */
  cuentaSAT: string;
  tipo: AccountType;
}

/**
 * La tabla del contrato. 401.04 para la farmacia a tasa 0: es el agrupador
 * oficial de «Ventas y/o servicios gravados al 0%» (401.02 es «a la tasa
 * general de contado», un corte por forma de cobro, no por tasa).
 */
export const MAPA_DEFAULT: Record<ClaveMotor, DefinicionClave> = {
  INGRESO_HOSPITALIZACION: { clave: "INGRESO_HOSPITALIZACION", descripcion: "Ingresos por hospitalización (estancia y habitación)", cuentaSAT: "401.01", tipo: "INGRESO" },
  INGRESO_QUIROFANO: { clave: "INGRESO_QUIROFANO", descripcion: "Ingresos por quirófano y procedimientos", cuentaSAT: "401.01", tipo: "INGRESO" },
  INGRESO_URGENCIAS: { clave: "INGRESO_URGENCIAS", descripcion: "Ingresos por urgencias", cuentaSAT: "401.01", tipo: "INGRESO" },
  INGRESO_ESTUDIOS: { clave: "INGRESO_ESTUDIOS", descripcion: "Ingresos por estudios de laboratorio e imagen", cuentaSAT: "401.01", tipo: "INGRESO" },
  INGRESO_FARMACIA_16: { clave: "INGRESO_FARMACIA_16", descripcion: "Farmacia suministrada en hospitalización (gravada al 16 %)", cuentaSAT: "401.01", tipo: "INGRESO" },
  INGRESO_FARMACIA_0: { clave: "INGRESO_FARMACIA_0", descripcion: "Farmacia en venta directa (tasa 0 %)", cuentaSAT: "401.04", tipo: "INGRESO" },
  INGRESO_MATERIAL: { clave: "INGRESO_MATERIAL", descripcion: "Material de curación y equipo", cuentaSAT: "401.01", tipo: "INGRESO" },
  INGRESO_OTROS: { clave: "INGRESO_OTROS", descripcion: "Otros ingresos hospitalarios", cuentaSAT: "401.01", tipo: "INGRESO" },
  HONORARIOS_POR_CUENTA_DE_TERCEROS: { clave: "HONORARIOS_POR_CUENTA_DE_TERCEROS", descripcion: "Honorarios médicos cobrados por cuenta de terceros (pasivo con el médico)", cuentaSAT: "205.06", tipo: "PASIVO" },
  RETENCION_ISR_HONORARIOS: { clave: "RETENCION_ISR_HONORARIOS", descripcion: "ISR retenido a médicos personas físicas (10 %)", cuentaSAT: "216.04", tipo: "PASIVO" },
  RETENCION_IVA_HONORARIOS: { clave: "RETENCION_IVA_HONORARIOS", descripcion: "IVA retenido a médicos personas físicas (dos terceras partes)", cuentaSAT: "216.10", tipo: "PASIVO" },
  COSTO_FARMACIA: { clave: "COSTO_FARMACIA", descripcion: "Costo de farmacia y material aplicado al paciente", cuentaSAT: "501.01", tipo: "COSTO" },
  INVENTARIO_FARMACIA: { clave: "INVENTARIO_FARMACIA", descripcion: "Inventario de farmacia", cuentaSAT: "115.01", tipo: "ACTIVO" },
  ANTICIPOS_PACIENTES: { clave: "ANTICIPOS_PACIENTES", descripcion: "Depósitos y anticipos de pacientes", cuentaSAT: "206.01", tipo: "PASIVO" },
  CAJA: { clave: "CAJA", descripcion: "Caja (depósitos en efectivo)", cuentaSAT: "101.01", tipo: "ACTIVO" },
  BANCOS: { clave: "BANCOS", descripcion: "Bancos (depósitos por transferencia, tarjeta o cheque)", cuentaSAT: "102.01", tipo: "ACTIVO" },
  CLIENTES: { clave: "CLIENTES", descripcion: "Clientes (cuenta por cobrar del paciente o pagador)", cuentaSAT: "105.01", tipo: "ACTIVO" },
};

export function esClaveMotor(s: unknown): s is ClaveMotor {
  return typeof s === "string" && (CLAVES_MOTOR as readonly string[]).includes(s);
}

/** codigoMotor con el que la clave vive en PostingCuentaOverride: `hospital:INGRESO_QUIROFANO`. */
export const PREFIJO_OVERRIDE_HOSPITAL = "hospital:";
export const codigoMotorDe = (clave: ClaveMotor) => `${PREFIJO_OVERRIDE_HOSPITAL}${clave}`;

/**
 * Cuentas que el hospital usa y el catálogo semilla del hub no trae. Nombres
 * OFICIALES del código agrupador (codigo-agrupador.ts); un test lo coteja.
 */
export const CUENTAS_HOSPITAL: CatalogAccount[] = [
  { cuentaSAT: "205", subcuenta: "205.06", nombre: "Otros acreedores diversos a corto plazo", tipo: "PASIVO", nivel: 3 },
  { cuentaSAT: "206", subcuenta: null, nombre: "Anticipo de cliente", tipo: "PASIVO", nivel: 2 },
  { cuentaSAT: "206", subcuenta: "206.01", nombre: "Anticipo de cliente nacional", tipo: "PASIVO", nivel: 3 },
  { cuentaSAT: "216", subcuenta: "216.10", nombre: "Impuestos retenidos de IVA", tipo: "PASIVO", nivel: 3 },
  { cuentaSAT: "401", subcuenta: "401.04", nombre: "Ventas y/o servicios gravados al 0%", tipo: "INGRESO", nivel: 3 },
];

// ─── Cargo → clave ───────────────────────────────────────────────────────────

/**
 * La clave del motor a la que va un cargo de la cuenta. Farmacia se parte por
 * contexto de IVA (criterio 9/IVA/N): suministrada al 16 %, vendida al 0 %; un
 * cargo viejo sin contexto se clasifica por la tasa que lleva. El HONORARIO no
 * es ingreso: el hospital lo cobra por cuenta del médico (pasivo).
 */
export function claveDeCargo(c: { categoria: HospCargoCategoria; ivaContexto?: HospIvaContexto | null; ivaTasa?: number | null }): ClaveMotor {
  switch (c.categoria) {
    case "HABITACION":
      return "INGRESO_HOSPITALIZACION";
    case "URGENCIAS":
      return "INGRESO_URGENCIAS";
    case "QUIROFANO":
    case "PROCEDIMIENTO":
      return "INGRESO_QUIROFANO";
    case "ESTUDIO":
      return "INGRESO_ESTUDIOS";
    case "FARMACIA":
      if (c.ivaContexto === "VENTA_DIRECTA") return "INGRESO_FARMACIA_0";
      if (c.ivaContexto === "SUMINISTRO_HOSPITALARIO") return "INGRESO_FARMACIA_16";
      return c.ivaTasa != null && Number(c.ivaTasa) > 0 ? "INGRESO_FARMACIA_16" : "INGRESO_FARMACIA_0";
    case "MATERIAL":
    case "EQUIPO":
      return "INGRESO_MATERIAL";
    case "HONORARIO":
      return "HONORARIOS_POR_CUENTA_DE_TERCEROS";
    case "OTRO":
    default:
      return "INGRESO_OTROS";
  }
}

// ─── Configuración (HospConfig.cuentasContables) ─────────────────────────────

export interface CuentaConfigurada {
  /** Código agrupador del SAT («401.03»). */
  cuentaSAT: string;
  /** Código de una cuenta concreta del catálogo de la empresa («4101-0003-0000», «401.01.02»). */
  subcuenta?: string | null;
}

export type ConfigCuentas = Partial<Record<ClaveMotor, CuentaConfigurada>>;

const limpiarCodigo = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 && t.length <= 40 ? t : null;
};

/** El JSON guardado → mapa tipado; lo que no tenga forma se ignora. */
export function leerConfigCuentas(json: unknown): ConfigCuentas {
  const out: ConfigCuentas = {};
  if (!json || typeof json !== "object" || Array.isArray(json)) return out;
  for (const [clave, valor] of Object.entries(json as Record<string, unknown>)) {
    if (!esClaveMotor(clave) || !valor || typeof valor !== "object") continue;
    const v = valor as { cuentaSAT?: unknown; subcuenta?: unknown };
    const cuentaSAT = limpiarCodigo(v.cuentaSAT);
    const subcuenta = limpiarCodigo(v.subcuenta);
    if (!cuentaSAT && !subcuenta) continue;
    out[clave] = { cuentaSAT: cuentaSAT ?? MAPA_DEFAULT[clave].cuentaSAT, subcuenta };
  }
  return out;
}

export interface ConfigContable {
  activa: boolean;
  cuentas: ConfigCuentas;
  /** RFC de la empresa: sólo una persona MORAL retiene a los médicos (Art. 106 LISR). */
  empresaRetiene: boolean;
}

export async function cargarConfigContable(db: Db, companyId: string): Promise<ConfigContable> {
  const [config, company] = await Promise.all([
    db.hospConfig.findUnique({ where: { companyId }, select: { contabilidadActiva: true, cuentasContables: true } }),
    db.company.findUnique({ where: { id: companyId }, select: { rfc: true } }),
  ]);
  return {
    activa: config?.contabilidadActiva ?? false,
    cuentas: leerConfigCuentas(config?.cuentasContables),
    empresaRetiene: (company?.rfc ?? "").trim().length === 12,
  };
}

// ─── Resolución de cuentas ───────────────────────────────────────────────────

export interface CuentaResuelta {
  id: string;
  cuentaSAT: string;
  subcuenta: string | null;
  nombre: string;
  tipo: AccountType;
}

const TIPO_POR_DIGITO: Record<string, AccountType> = { "1": "ACTIVO", "2": "PASIVO", "3": "CAPITAL", "4": "INGRESO", "5": "COSTO", "6": "GASTO", "7": "GASTO" };

/**
 * La definición con la que se crearía una cuenta que falta: catálogo semilla
 * del hub, extras del clasificador, las del hospital y, como último recurso,
 * el agrupador oficial completo (tipo por el primer dígito, nivel por la
 * forma del código). Null si el código no es del SAT.
 */
export function definicionCatalogo(codigo: string): CatalogAccount | null {
  const def = [...SAT_STARTER_CATALOG, ...EXTRA_ACCOUNTS_FOR_CLASSIFICATION, ...CUENTAS_HOSPITAL].find((a) => (a.subcuenta ?? a.cuentaSAT) === codigo);
  if (def) return def;
  const nombre = CODIGO_AGRUPADOR_OFICIAL[codigo];
  const tipo = TIPO_POR_DIGITO[codigo.charAt(0)];
  if (!nombre || !tipo) return null;
  const punto = codigo.indexOf(".");
  return punto > 0
    ? { cuentaSAT: codigo.slice(0, punto), subcuenta: codigo, nombre, tipo, nivel: 3 }
    : { cuentaSAT: codigo, subcuenta: null, nombre, tipo, nivel: codigo.length <= 3 && codigo.endsWith("00") ? 1 : 2 };
}

const seleccionCuenta = { id: true, cuentaSAT: true, subcuenta: true, nombre: true, tipo: true } as const;

/**
 * La cuenta de la empresa para un código, SIN crear nada: override del
 * contador para ese código, inversión codAgrup → cuenta propia cuando es
 * única, o la cuenta activa con ese código (subcuenta primero). Igual que
 * seed-catalog.resolveAccount, pero con el cliente de la transacción.
 */
export async function localizarCuenta(db: Db, companyId: string, codigo: string): Promise<CuentaResuelta | null> {
  const override = await db.postingCuentaOverride.findUnique({
    where: { companyId_codigoMotor: { companyId, codigoMotor: codigo } },
    include: { cuenta: { select: { ...seleccionCuenta, isActive: true } } },
  });
  if (override) return override.cuenta.isActive ? override.cuenta : null;

  const propias = await db.chartAccount.findMany({ where: { companyId, isActive: true, codAgrup: codigo }, select: seleccionCuenta, take: 2 });
  if (propias.length === 1) return propias[0];

  return db.chartAccount.findFirst({
    where: { companyId, isActive: true, OR: [{ subcuenta: codigo }, { cuentaSAT: codigo, subcuenta: null }] },
    orderBy: { createdAt: "desc" },
    select: seleccionCuenta,
  });
}

/** Los códigos que se intentan para una clave, del más específico al default. */
function codigosDe(clave: ClaveMotor, config?: ConfigCuentas | null): string[] {
  const cfg = config?.[clave];
  return [...new Set([cfg?.subcuenta ?? null, cfg?.cuentaSAT ?? null, MAPA_DEFAULT[clave].cuentaSAT].filter((c): c is string => !!c))];
}

/**
 * Recorre los códigos del más específico al default: el primero que exista en
 * la empresa gana; si no existe pero está en el catálogo, ése es el que se
 * crea (sólo con `crear`) — un código configurado no se salta al default por
 * no existir todavía. Un código que no es de nadie (ni existe ni es del SAT)
 * se ignora y sigue el siguiente.
 */
async function resolverPorCodigos(db: Db, companyId: string, codigos: string[], crear: boolean): Promise<CuentaResuelta | null> {
  for (const codigo of codigos) {
    const cuenta = await localizarCuenta(db, companyId, codigo);
    if (cuenta) return cuenta;
    const def = definicionCatalogo(codigo);
    if (!def) continue;
    if (!crear) return null;
    return db.chartAccount.create({
      data: {
        companyId,
        cuentaSAT: def.cuentaSAT,
        subcuenta: def.subcuenta,
        nombre: def.nombre,
        tipo: def.tipo,
        nivel: def.nivel,
        naturaleza: def.naturaleza ?? naturalezaPorTipo(def.tipo),
      },
      select: seleccionCuenta,
    });
  }
  return null;
}

/**
 * La cuenta del libro para una clave del motor: override `hospital:<clave>`,
 * luego lo configurado, luego el default; lo que no exista se crea desde el
 * catálogo. Nunca devuelve null: el default siempre es un código del SAT.
 */
export async function resolverCuenta(db: Db, companyId: string, clave: ClaveMotor, opts: { config?: ConfigCuentas | null } = {}): Promise<CuentaResuelta> {
  const override = await db.postingCuentaOverride.findUnique({
    where: { companyId_codigoMotor: { companyId, codigoMotor: codigoMotorDe(clave) } },
    include: { cuenta: { select: { ...seleccionCuenta, isActive: true } } },
  });
  if (override?.cuenta.isActive) return override.cuenta;

  const codigos = codigosDe(clave, opts.config);
  const cuenta = await resolverPorCodigos(db, companyId, codigos, true);
  if (cuenta) return cuenta;
  throw new HospitalError(409, `No hay cuenta contable para ${clave}: ninguno de los códigos ${codigos.join(", ")} existe en el catálogo`);
}

/** El catálogo activo de la empresa como lo consumen apertura y leer-balanza: código = subcuenta ?? cuenta. */
export async function catalogoDeEmpresa(db: Db, companyId: string) {
  const cuentas = await db.chartAccount.findMany({
    where: { companyId, isActive: true },
    select: { id: true, cuentaSAT: true, subcuenta: true, nombre: true, nivel: true, tipo: true, naturaleza: true },
    orderBy: [{ cuentaSAT: "asc" }, { subcuenta: "asc" }],
  });
  return cuentas.map((a) => ({
    id: a.id,
    codigo: a.subcuenta ?? a.cuentaSAT,
    nombre: a.nombre,
    tipo: a.tipo,
    naturaleza: ((a.naturaleza as "D" | "A" | null) ?? naturalezaPorTipo(a.tipo)) as "D" | "A",
    nivel: a.nivel,
  }));
}

// ─── Mapa (GET /contabilidad/mapa) ───────────────────────────────────────────

export type OrigenCuenta = "DEFAULT" | "CONFIG" | "OVERRIDE";

export interface RenglonMapa {
  clave: ClaveMotor;
  descripcion: string;
  tipo: AccountType;
  cuentaSAT: string;
  subcuenta: string | null;
  origen: OrigenCuenta;
  /** La cuenta del catálogo que hoy recibiría el asiento; null = se creará al asentar. */
  cuenta: { id: string; codigo: string; nombre: string } | null;
}

export const codigoDeCuenta = (c: { cuentaSAT: string; subcuenta: string | null }) => c.subcuenta ?? c.cuentaSAT;

export async function mapaCuentas(db: Db, companyId: string): Promise<{ activa: boolean; claves: RenglonMapa[] }> {
  const config = await cargarConfigContable(db, companyId);
  const overrides = await db.postingCuentaOverride.findMany({
    where: { companyId, codigoMotor: { startsWith: PREFIJO_OVERRIDE_HOSPITAL } },
    include: { cuenta: { select: { ...seleccionCuenta, isActive: true } } },
  });
  const porClave = new Map(overrides.filter((o) => o.cuenta.isActive).map((o) => [o.codigoMotor.slice(PREFIJO_OVERRIDE_HOSPITAL.length), o.cuenta]));

  const claves: RenglonMapa[] = [];
  for (const clave of CLAVES_MOTOR) {
    const def = MAPA_DEFAULT[clave];
    const cfg = config.cuentas[clave];
    const override = porClave.get(clave);
    // Sin crear: null = la cuenta se creará del catálogo al primer asiento.
    const cuenta: CuentaResuelta | null = override ?? (await resolverPorCodigos(db, companyId, codigosDe(clave, config.cuentas), false));
    claves.push({
      clave,
      descripcion: def.descripcion,
      tipo: def.tipo,
      cuentaSAT: cfg?.cuentaSAT ?? def.cuentaSAT,
      subcuenta: cfg?.subcuenta ?? (override ? codigoDeCuenta(override) : null),
      origen: override ? "OVERRIDE" : cfg ? "CONFIG" : "DEFAULT",
      cuenta: cuenta ? { id: cuenta.id, codigo: codigoDeCuenta(cuenta), nombre: cuenta.nombre } : null,
    });
  }
  return { activa: config.activa, claves };
}
