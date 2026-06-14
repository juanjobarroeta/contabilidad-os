// ─────────────────────────────────────────────────────────────────────────────
// SAT Código Agrupador (COE) — starter chart of accounts
//
// This is a MINIMAL subset (~40 accounts) of the official SAT código agrupador
// catalog, covering the 80% case for a typical Mexican PyME. Customers can
// add custom subaccounts later, but every account here uses real SAT codes
// so the monthly COE XML export is compliant out of the box.
//
// Reference: https://www.sat.gob.mx/cs/Satellite?blobcol=urldata&blobkey=id&blobtable=MungoBlobs&blobwhere=1461173482033
// ─────────────────────────────────────────────────────────────────────────────

import type { AccountType } from "@prisma/client";

export type CatalogAccount = {
  cuentaSAT: string;   // SAT parent code e.g. "102"
  subcuenta: string | null; // subaccount e.g. "102.01" (null for level-1 headers)
  nombre: string;
  tipo: AccountType;
  nivel: number;
  // Override de naturaleza COE ("D"|"A"); sólo para contra-cuentas. Si se omite
  // se deriva del tipo (ACTIVO/GASTO/COSTO → D, resto → A).
  naturaleza?: "D" | "A";
};

// Helper to mark special-purpose accounts the posting engine looks up by code.
// Centralized here so we can change names without breaking lookups.
export const COE_CODES = {
  // Active
  CAJA:                 "101.01",
  BANCOS:               "102.01",
  CLIENTES_NACIONALES:  "105.01",
  DEUDORES_DIVERSOS:    "107.01",
  IVA_ACREDITABLE:      "118.01",   // IVA pagado al comprar (recuperable)
  IVA_ACREDITABLE_PEND: "119.01",   // IVA pendiente de pagar al proveedor
  ISR_PAGADO_TERCEROS:  "107.05",   // Cuando un cliente nos retiene ISR (asset/credit at SAT)
  // Passive
  PROVEEDORES:          "201.01",
  ACREEDORES_DIVERSOS:  "205.01",
  PRESTAMOS_RECIBIDOS:  "205.02",   // Préstamos a corto plazo (de socios, terceros)
  PRESTAMOS_OTORGADOS:  "107.06",   // Cuando le prestamos dinero a un tercero
  CAPITAL_SOCIAL:       "301.01",
  IVA_TRASLADADO:       "208.01",   // IVA cobrado al vender
  IVA_TRASLADADO_PEND:  "209.01",   // IVA pendiente de cobrar al cliente
  IVA_POR_PAGAR:        "216.01",
  ISR_POR_PAGAR:        "213.01",
  ISR_RETENIDO_NOMINA:  "214.01",
  ISR_RETENIDO_HONORARIOS: "214.02",  // ISR/IVA retenido a proveedores (honorarios, arrendamiento)
  IMSS_POR_PAGAR:       "215.01",
  // Capital
  RESULTADO_EJERCICIO:  "305.01",
  RESULTADOS_ACUMULADOS: "306.01",
  // Income
  VENTAS_GENERAL:       "401.01",
  OTROS_INGRESOS:       "402.01",
  // Expenses
  SUELDOS_SALARIOS:     "601.01",
  HONORARIOS:           "601.02",
  RENTAS:               "601.03",
  COMISIONES_BANCARIAS: "601.84",
  GASTOS_NO_DEDUCIBLES: "603.01",
  OTROS_GASTOS:         "601.99",
  IMPUESTOS_DERECHOS:   "601.20",
  CUOTAS_IMSS_PATRONAL: "601.14",  // Cuotas IMSS a cargo del patrón (gasto)
  CUOTAS_INFONAVIT:     "601.15",  // Aportaciones Infonavit patronal (gasto)
  DIFERENCIAS_REDONDEO: "704.01",
} as const;

export const SAT_STARTER_CATALOG: CatalogAccount[] = [
  // ─── 100 ACTIVO ──────────────────────────────────────────────────────────
  { cuentaSAT: "100", subcuenta: null,         nombre: "Activo",                              tipo: "ACTIVO",  nivel: 1 },
  { cuentaSAT: "101", subcuenta: null,         nombre: "Caja",                                tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "101", subcuenta: "101.01",     nombre: "Caja y efectivo",                     tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "102", subcuenta: null,         nombre: "Bancos",                              tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "102", subcuenta: "102.01",     nombre: "Bancos nacionales moneda nacional",   tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "105", subcuenta: null,         nombre: "Clientes",                            tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "105", subcuenta: "105.01",     nombre: "Clientes nacionales",                 tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "107", subcuenta: null,         nombre: "Deudores diversos",                   tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "107", subcuenta: "107.01",     nombre: "Deudores diversos nacionales",        tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "107", subcuenta: "107.05",     nombre: "ISR pagado por terceros (retenido a favor)", tipo: "ACTIVO", nivel: 3 },
  { cuentaSAT: "107", subcuenta: "107.06",     nombre: "Préstamos otorgados a terceros",      tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "118", subcuenta: null,         nombre: "IVA acreditable pagado",              tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "118", subcuenta: "118.01",     nombre: "IVA acreditable pagado",              tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "119", subcuenta: null,         nombre: "IVA pendiente de acreditar",          tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "119", subcuenta: "119.01",     nombre: "IVA pendiente de pagar al proveedor", tipo: "ACTIVO",  nivel: 3 },

  // ─── 200 PASIVO ──────────────────────────────────────────────────────────
  { cuentaSAT: "200", subcuenta: null,         nombre: "Pasivo",                              tipo: "PASIVO",  nivel: 1 },
  { cuentaSAT: "201", subcuenta: null,         nombre: "Proveedores",                         tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "201", subcuenta: "201.01",     nombre: "Proveedores nacionales",              tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "205", subcuenta: null,         nombre: "Acreedores diversos",                 tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "205", subcuenta: "205.01",     nombre: "Acreedores diversos nacionales",      tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "205", subcuenta: "205.02",     nombre: "Préstamos por pagar",                 tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "208", subcuenta: null,         nombre: "IVA trasladado cobrado",              tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "208", subcuenta: "208.01",     nombre: "IVA trasladado cobrado",              tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "209", subcuenta: null,         nombre: "IVA trasladado pendiente de cobro",   tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "209", subcuenta: "209.01",     nombre: "IVA pendiente de cobrar al cliente",  tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "213", subcuenta: null,         nombre: "Impuestos sobre la renta por pagar",  tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "213", subcuenta: "213.01",     nombre: "ISR por pagar",                       tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "214", subcuenta: null,         nombre: "ISR retenido",                        tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "214", subcuenta: "214.01",     nombre: "ISR retenido por sueldos",            tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "214", subcuenta: "214.02",     nombre: "ISR/IVA retenido a proveedores",      tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "215", subcuenta: null,         nombre: "Aportaciones de seguridad social",    tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "215", subcuenta: "215.01",     nombre: "IMSS e INFONAVIT por pagar",          tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "216", subcuenta: null,         nombre: "IVA por pagar",                       tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "216", subcuenta: "216.01",     nombre: "IVA por pagar",                       tipo: "PASIVO",  nivel: 3 },

  // ─── 300 CAPITAL ─────────────────────────────────────────────────────────
  { cuentaSAT: "300", subcuenta: null,         nombre: "Capital contable",                    tipo: "CAPITAL", nivel: 1 },
  { cuentaSAT: "301", subcuenta: null,         nombre: "Capital social",                      tipo: "CAPITAL", nivel: 2 },
  { cuentaSAT: "301", subcuenta: "301.01",     nombre: "Capital social fijo",                 tipo: "CAPITAL", nivel: 3 },
  { cuentaSAT: "305", subcuenta: null,         nombre: "Resultado del ejercicio",             tipo: "CAPITAL", nivel: 2 },
  { cuentaSAT: "305", subcuenta: "305.01",     nombre: "Resultado del ejercicio",             tipo: "CAPITAL", nivel: 3 },
  { cuentaSAT: "306", subcuenta: null,         nombre: "Resultados de ejercicios anteriores", tipo: "CAPITAL", nivel: 2 },
  { cuentaSAT: "306", subcuenta: "306.01",     nombre: "Utilidades acumuladas",               tipo: "CAPITAL", nivel: 3 },

  // ─── 400 INGRESOS ────────────────────────────────────────────────────────
  { cuentaSAT: "400", subcuenta: null,         nombre: "Ingresos",                            tipo: "INGRESO", nivel: 1 },
  { cuentaSAT: "401", subcuenta: null,         nombre: "Ingresos por ventas y/o servicios",   tipo: "INGRESO", nivel: 2 },
  { cuentaSAT: "401", subcuenta: "401.01",     nombre: "Ventas y/o servicios gravados",       tipo: "INGRESO", nivel: 3 },
  { cuentaSAT: "402", subcuenta: null,         nombre: "Otros ingresos",                      tipo: "INGRESO", nivel: 2 },
  { cuentaSAT: "402", subcuenta: "402.01",     nombre: "Otros ingresos",                      tipo: "INGRESO", nivel: 3 },

  // ─── 600 GASTOS ──────────────────────────────────────────────────────────
  { cuentaSAT: "600", subcuenta: null,         nombre: "Gastos",                              tipo: "GASTO",   nivel: 1 },
  { cuentaSAT: "601", subcuenta: null,         nombre: "Gastos generales",                    tipo: "GASTO",   nivel: 2 },
  { cuentaSAT: "601", subcuenta: "601.01",     nombre: "Sueldos y salarios",                  tipo: "GASTO",   nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.02",     nombre: "Honorarios",                          tipo: "GASTO",   nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.03",     nombre: "Rentas",                              tipo: "GASTO",   nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.20",     nombre: "Impuestos y derechos",                tipo: "GASTO",   nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.14",     nombre: "Cuotas IMSS patronal",                tipo: "GASTO",   nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.15",     nombre: "Aportaciones Infonavit patronal",     tipo: "GASTO",   nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.84",     nombre: "Comisiones bancarias",                tipo: "GASTO",   nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.99",     nombre: "Otros gastos",                        tipo: "GASTO",   nivel: 3 },
  { cuentaSAT: "603", subcuenta: null,         nombre: "Gastos no deducibles",                tipo: "GASTO",   nivel: 2 },
  { cuentaSAT: "603", subcuenta: "603.01",     nombre: "Gastos no deducibles",                tipo: "GASTO",   nivel: 3 },

  // ─── 700 OTROS ───────────────────────────────────────────────────────────
  { cuentaSAT: "700", subcuenta: null,         nombre: "Otras cuentas",                       tipo: "GASTO",   nivel: 1 },
  { cuentaSAT: "704", subcuenta: null,         nombre: "Diferencias y redondeo",              tipo: "GASTO",   nivel: 2 },
  { cuentaSAT: "704", subcuenta: "704.01",     nombre: "Diferencias por redondeo",            tipo: "GASTO",   nivel: 3 },
];
