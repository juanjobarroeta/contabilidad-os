// ─────────────────────────────────────────────────────────────────────────────
// SAT Código Agrupador (COE) — starter chart of accounts
//
// This is a MINIMAL subset of the official SAT código agrupador catalog,
// covering the 80% case for a typical Mexican PyME. Customers can add custom
// subaccounts later, but every account here uses REAL SAT codes with their
// OFFICIAL names so the monthly COE XML export is compliant out of the box.
//
// Fuente de verdad: src/lib/contabilidad/codigo-agrupador.ts (lista oficial
// completa del Anexo 24). Un test (codigo-agrupador.test.ts) verifica que cada
// código de este archivo y del clasificador exista en la lista oficial y que
// el nombre sembrado coincida — el bug que motivó esto: el bloque 601.xx se
// asignó secuencialmente (combustibles caía en 601.15 «Despensa», el IMSS
// patronal en 601.14 «Destajo», el ISR retenido de nómina en 214.01
// «Dividendos por pagar»). scripts/repair-codigo-agrupador.ts repara los
// catálogos ya sembrados con los códigos viejos.
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
  // Activo
  CAJA:                 "101.01",
  BANCOS:               "102.01",
  CLIENTES_NACIONALES:  "105.01",
  DEUDORES_DIVERSOS:    "107.05",   // Otros deudores diversos
  PRESTAMOS_OTORGADOS:  "107.03",   // Partes relacionadas nacionales (interempresa)
  ISR_PAGADO_TERCEROS:  "113.02",   // ISR a favor (retenciones que nos hicieron)
  IVA_ACREDITABLE:      "118.01",   // IVA pagado al comprar (recuperable)
  IVA_ACREDITABLE_PEND: "119.01",   // IVA pendiente de pagar al proveedor
  // Pasivo
  PROVEEDORES:          "201.01",
  ACREEDORES_DIVERSOS:  "205.02",   // Acreedores diversos a corto plazo nacional
  PRESTAMOS_RECIBIDOS:  "205.04",   // Acreedores nacional parte relacionada (interempresa)
  IVA_TRASLADADO:       "208.01",   // IVA cobrado al vender
  IVA_TRASLADADO_PEND:  "209.01",   // IVA pendiente de cobrar al cliente
  IMSS_POR_PAGAR:       "211.01",   // Provisión de IMSS patronal por pagar
  IVA_POR_PAGAR:        "213.01",
  ISR_POR_PAGAR:        "213.03",
  ISR_RETENIDO_NOMINA:  "216.01",   // Impuestos retenidos de ISR por sueldos y salarios
  ISR_RETENIDO_HONORARIOS: "216.04", // Retenciones de ISR por servicios profesionales
  // Capital
  CAPITAL_SOCIAL:       "301.01",
  RESULTADOS_ACUMULADOS: "304.01",  // Utilidad de ejercicios anteriores
  RESULTADO_EJERCICIO:  "305.01",   // Utilidad del ejercicio
  // Ingresos
  // Inventario y costo de lo vendido. Los nombres son los OFICIALES del código
  // agrupador (codigo-agrupador.ts los cotejа letra por letra en su test).
  //
  // UNA sola cuenta de inventario, no cuatro: el subledger (Vehiculo,
  // Refaccion) ya distingue unidad nueva de seminueva y de refacción. El mayor
  // guarda el SALDO y el subledger el detalle; separarlos aquí duplicaría la
  // dimensión y obligaría a mantener las dos de acuerdo.
  INVENTARIO:           "115.01",  // Inventario (unidades y refacciones)
  COSTO_VENTA:          "501.01",  // Costo de venta (unidades y refacciones)
  COSTO_SERVICIO:       "501.02",  // Costo de servicios (Mano de obra)
  // ISAN: impuesto de la operación que el distribuidor cobra al comprador y
  // entera. No es gasto de operación ni margen — es un pasivo hasta enterarlo.
  ISAN_POR_PAGAR:       "213.07",  // Otros impuestos por pagar

  VENTAS_GENERAL:       "401.01",
  OTROS_INGRESOS:       "403.01",
  // Gastos
  SUELDOS_SALARIOS:     "601.01",
  CUOTAS_IMSS_PATRONAL: "601.26",  // Cuotas al IMSS (gasto patronal)
  CUOTAS_INFONAVIT:     "601.27",  // Aportaciones al infonavit (gasto patronal)
  HONORARIOS:           "601.38",  // Honorarios a PM residentes nacionales (caso dominante)
  HONORARIOS_PF:        "601.34",  // Honorarios a PF residentes nacionales
  RENTAS:               "601.46",  // Arrendamiento a PM residentes nacionales
  RENTAS_PF:            "601.45",  // Arrendamiento a PF residentes nacionales
  COMBUSTIBLES:         "601.48",  // Combustibles y lubricantes
  IMPUESTOS_DERECHOS:   "601.58",  // Otros impuestos y derechos
  GASTOS_NO_DEDUCIBLES: "601.83",  // Gastos no deducibles (sin requisitos fiscales)
  OTROS_GASTOS:         "601.84",  // Otros gastos generales
  COMISIONES_BANCARIAS: "701.10",  // Gastos financieros → Comisiones bancarias
  DIFERENCIAS_REDONDEO: "701.11",  // Otros gastos financieros (redondeos)
} as const;

export const SAT_STARTER_CATALOG: CatalogAccount[] = [
  // ─── 100 ACTIVO ──────────────────────────────────────────────────────────
  { cuentaSAT: "100", subcuenta: null,         nombre: "Activo",                              tipo: "ACTIVO",  nivel: 1 },
  { cuentaSAT: "101", subcuenta: null,         nombre: "Caja",                                tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "101", subcuenta: "101.01",     nombre: "Caja y efectivo",                     tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "102", subcuenta: null,         nombre: "Bancos",                              tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "102", subcuenta: "102.01",     nombre: "Bancos nacionales",                   tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "105", subcuenta: null,         nombre: "Clientes",                            tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "105", subcuenta: "105.01",     nombre: "Clientes nacionales",                 tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "107", subcuenta: null,         nombre: "Deudores diversos",                   tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "107", subcuenta: "107.03",     nombre: "Partes relacionadas nacionales",      tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "107", subcuenta: "107.05",     nombre: "Otros deudores diversos",             tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "113", subcuenta: null,         nombre: "Impuestos a favor",                   tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "113", subcuenta: "113.02",     nombre: "ISR a favor",                         tipo: "ACTIVO",  nivel: 3 },
  // ── Activo fijo (Fase 3: depreciación contable al libro) ──
  { cuentaSAT: "152", subcuenta: null,         nombre: "Edificios",                           tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "152", subcuenta: "152.01",     nombre: "Edificios",                           tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "153", subcuenta: null,         nombre: "Maquinaria y equipo",                 tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "153", subcuenta: "153.01",     nombre: "Maquinaria y equipo",                 tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "154", subcuenta: null,         nombre: "Automóviles, autobuses, camiones de carga, tractocamiones, montacargas y remolques", tipo: "ACTIVO", nivel: 2 },
  { cuentaSAT: "154", subcuenta: "154.01",     nombre: "Automóviles, autobuses, camiones de carga, tractocamiones, montacargas y remolques", tipo: "ACTIVO", nivel: 3 },
  { cuentaSAT: "155", subcuenta: null,         nombre: "Mobiliario y equipo de oficina",      tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "155", subcuenta: "155.01",     nombre: "Mobiliario y equipo de oficina",      tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "156", subcuenta: null,         nombre: "Equipo de cómputo",                   tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "156", subcuenta: "156.01",     nombre: "Equipo de cómputo",                   tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "157", subcuenta: null,         nombre: "Equipo de comunicación",              tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "157", subcuenta: "157.01",     nombre: "Equipo de comunicación",              tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "160", subcuenta: null,         nombre: "Otros activos fijos",                 tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "160", subcuenta: "160.01",     nombre: "Otros activos fijos",                 tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "164", subcuenta: null,         nombre: "Troqueles, moldes, matrices y herramental", tipo: "ACTIVO", nivel: 2 },
  { cuentaSAT: "164", subcuenta: "164.01",     nombre: "Troqueles, moldes, matrices y herramental", tipo: "ACTIVO", nivel: 3 },
  // Depreciación acumulada: contra-activo (naturaleza acreedora).
  { cuentaSAT: "171", subcuenta: null,         nombre: "Depreciación acumulada de activos fijos", tipo: "ACTIVO", nivel: 2, naturaleza: "A" },
  { cuentaSAT: "171", subcuenta: "171.01",     nombre: "Depreciación acumulada de edificios", tipo: "ACTIVO",  nivel: 3, naturaleza: "A" },
  { cuentaSAT: "171", subcuenta: "171.02",     nombre: "Depreciación acumulada de maquinaria y equipo", tipo: "ACTIVO", nivel: 3, naturaleza: "A" },
  { cuentaSAT: "171", subcuenta: "171.04",     nombre: "Depreciación acumulada de mobiliario y equipo de oficina", tipo: "ACTIVO", nivel: 3, naturaleza: "A" },
  { cuentaSAT: "171", subcuenta: "171.05",     nombre: "Depreciación acumulada de equipo de cómputo", tipo: "ACTIVO", nivel: 3, naturaleza: "A" },
  { cuentaSAT: "171", subcuenta: "171.06",     nombre: "Depreciación acumulada de equipo de comunicación", tipo: "ACTIVO", nivel: 3, naturaleza: "A" },
  { cuentaSAT: "171", subcuenta: "171.08",     nombre: "Depreciación acumulada de otros activos fijos", tipo: "ACTIVO", nivel: 3, naturaleza: "A" },
  { cuentaSAT: "171", subcuenta: "171.12",     nombre: "Depreciación acumulada de troqueles, moldes, matrices y herramental", tipo: "ACTIVO", nivel: 3, naturaleza: "A" },
  { cuentaSAT: "118", subcuenta: null,         nombre: "Impuestos acreditables pagados",      tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "118", subcuenta: "118.01",     nombre: "IVA acreditable pagado",              tipo: "ACTIVO",  nivel: 3 },
  { cuentaSAT: "119", subcuenta: null,         nombre: "Impuestos acreditables por pagar",    tipo: "ACTIVO",  nivel: 2 },
  { cuentaSAT: "119", subcuenta: "119.01",     nombre: "IVA pendiente de pago",               tipo: "ACTIVO",  nivel: 3 },

  // ─── 200 PASIVO ──────────────────────────────────────────────────────────
  { cuentaSAT: "200", subcuenta: null,         nombre: "Pasivo",                              tipo: "PASIVO",  nivel: 1 },
  { cuentaSAT: "201", subcuenta: null,         nombre: "Proveedores",                         tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "201", subcuenta: "201.01",     nombre: "Proveedores nacionales",              tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "205", subcuenta: null,         nombre: "Acreedores diversos a corto plazo",   tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "205", subcuenta: "205.02",     nombre: "Acreedores diversos a corto plazo nacional", tipo: "PASIVO", nivel: 3 },
  { cuentaSAT: "205", subcuenta: "205.04",     nombre: "Acreedores diversos a corto plazo nacional parte relacionada", tipo: "PASIVO", nivel: 3 },
  { cuentaSAT: "208", subcuenta: null,         nombre: "Impuestos trasladados cobrados",      tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "208", subcuenta: "208.01",     nombre: "IVA trasladado cobrado",              tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "209", subcuenta: null,         nombre: "Impuestos trasladados no cobrados",   tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "209", subcuenta: "209.01",     nombre: "IVA trasladado no cobrado",           tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "211", subcuenta: null,         nombre: "Provisión de contribuciones de seguridad social por pagar", tipo: "PASIVO", nivel: 2 },
  { cuentaSAT: "211", subcuenta: "211.01",     nombre: "Provisión de IMSS patronal por pagar", tipo: "PASIVO", nivel: 3 },
  { cuentaSAT: "213", subcuenta: null,         nombre: "Impuestos y derechos por pagar",      tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "213", subcuenta: "213.01",     nombre: "IVA por pagar",                       tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "213", subcuenta: "213.03",     nombre: "ISR por pagar",                       tipo: "PASIVO",  nivel: 3 },
  { cuentaSAT: "216", subcuenta: null,         nombre: "Impuestos retenidos",                 tipo: "PASIVO",  nivel: 2 },
  { cuentaSAT: "216", subcuenta: "216.01",     nombre: "Impuestos retenidos de ISR por sueldos y salarios", tipo: "PASIVO", nivel: 3 },
  { cuentaSAT: "216", subcuenta: "216.04",     nombre: "Impuestos retenidos de ISR por servicios profesionales", tipo: "PASIVO", nivel: 3 },

  // ─── 300 CAPITAL ─────────────────────────────────────────────────────────
  { cuentaSAT: "300", subcuenta: null,         nombre: "Capital contable",                    tipo: "CAPITAL", nivel: 1 },
  { cuentaSAT: "301", subcuenta: null,         nombre: "Capital social",                      tipo: "CAPITAL", nivel: 2 },
  { cuentaSAT: "301", subcuenta: "301.01",     nombre: "Capital fijo",                        tipo: "CAPITAL", nivel: 3 },
  { cuentaSAT: "304", subcuenta: null,         nombre: "Resultado de ejercicios anteriores",  tipo: "CAPITAL", nivel: 2 },
  { cuentaSAT: "304", subcuenta: "304.01",     nombre: "Utilidad de ejercicios anteriores",   tipo: "CAPITAL", nivel: 3 },
  { cuentaSAT: "305", subcuenta: null,         nombre: "Resultado del ejercicio",             tipo: "CAPITAL", nivel: 2 },
  { cuentaSAT: "305", subcuenta: "305.01",     nombre: "Utilidad del ejercicio",              tipo: "CAPITAL", nivel: 3 },

  // ─── 400 INGRESOS ────────────────────────────────────────────────────────
  { cuentaSAT: "400", subcuenta: null,         nombre: "Ingresos",                            tipo: "INGRESO", nivel: 1 },
  { cuentaSAT: "401", subcuenta: null,         nombre: "Ingresos",                            tipo: "INGRESO", nivel: 2 },
  { cuentaSAT: "401", subcuenta: "401.01",     nombre: "Ventas y/o servicios gravados a la tasa general", tipo: "INGRESO", nivel: 3 },
  { cuentaSAT: "403", subcuenta: null,         nombre: "Otros ingresos",                      tipo: "INGRESO", nivel: 2 },
  { cuentaSAT: "403", subcuenta: "403.01",     nombre: "Otros Ingresos",                      tipo: "INGRESO", nivel: 3 },

  // ─── 600 GASTOS ──────────────────────────────────────────────────────────
  { cuentaSAT: "600", subcuenta: null,         nombre: "Gastos",                              tipo: "GASTO",   nivel: 1 },
  { cuentaSAT: "601", subcuenta: null,         nombre: "Gastos generales",                    tipo: "GASTO",   nivel: 2 },
  { cuentaSAT: "601", subcuenta: "601.01",     nombre: "Sueldos y salarios",                  tipo: "GASTO",   nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.26",     nombre: "Cuotas al IMSS",                      tipo: "GASTO",   nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.27",     nombre: "Aportaciones al infonavit",           tipo: "GASTO",   nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.34",     nombre: "Honorarios a personas físicas residentes nacionales", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.38",     nombre: "Honorarios a personas morales residentes nacionales", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.45",     nombre: "Arrendamiento a personas físicas residentes nacionales", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.46",     nombre: "Arrendamiento a personas morales residentes nacionales", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.58",     nombre: "Otros impuestos y derechos",          tipo: "GASTO",   nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.83",     nombre: "Gastos no deducibles (sin requisitos fiscales)", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.84",     nombre: "Otros gastos generales",              tipo: "GASTO",   nivel: 3 },

  // ─── 700 RESULTADO INTEGRAL DE FINANCIAMIENTO ────────────────────────────
  { cuentaSAT: "700", subcuenta: null,         nombre: "Resultado integral de financiamiento", tipo: "GASTO",  nivel: 1 },
  { cuentaSAT: "701", subcuenta: null,         nombre: "Gastos financieros",                  tipo: "GASTO",   nivel: 2 },
  { cuentaSAT: "701", subcuenta: "701.10",     nombre: "Comisiones bancarias",                tipo: "GASTO",   nivel: 3 },
  { cuentaSAT: "701", subcuenta: "701.11",     nombre: "Otros gastos financieros",            tipo: "GASTO",   nivel: 3 },
  // Pérdida en baja de activo fijo (Fase 3).
  { cuentaSAT: "703", subcuenta: null,         nombre: "Otros gastos",                        tipo: "GASTO",   nivel: 2 },
  { cuentaSAT: "703", subcuenta: "703.02",     nombre: "Pérdida en venta y/o baja de edificios", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "703", subcuenta: "703.03",     nombre: "Pérdida en venta y/o baja de maquinaria y equipo", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "703", subcuenta: "703.05",     nombre: "Pérdida en venta y/o baja de mobiliario y equipo de oficina", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "703", subcuenta: "703.06",     nombre: "Pérdida en venta y/o baja de equipo de cómputo", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "703", subcuenta: "703.07",     nombre: "Pérdida en venta y/o baja de equipo de comunicación", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "703", subcuenta: "703.09",     nombre: "Pérdida en venta y/o baja de otros activos fijos", tipo: "GASTO", nivel: 3 },
];
