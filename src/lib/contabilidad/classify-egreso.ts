// ─────────────────────────────────────────────────────────────────────────────
// Auto-clasificación de CFDIs de egreso por claveProdServ.
//
// SAT's catalogo de productos y servicios es jerárquico de 8 dígitos:
//   - 2 primeros: segmento
//   - 2 siguientes: familia
//   - 2 siguientes: clase
//   - 2 siguientes: producto
//
// Esta función mapea la clave a una subcuenta del SAT COE. El usuario
// siempre puede corregir en caso de ambigüedad — esto es best-effort.
//
// Lista de segmentos más comunes en PyMEs:
//   10 = Material vivo vegetal y animal
//   11 = Material mineral, textil, etc.
//   12 = Material químico
//   15 = Combustibles, aceites, ceras
//   22 = Maquinaria construcción
//   24 = Material oficina
//   25 = Vehículos
//   26 = Energía
//   27 = Herramientas y maquinaria
//   39 = Herramientas electrónicas
//   40 = Sistemas, equipos eléctricos
//   42 = Equipo médico
//   43 = Tecnología / IT
//   44 = Muebles y equipos de oficina
//   50 = Alimentos
//   52 = Electrodomésticos
//   53 = Ropa y accesorios
//   55 = Publicaciones, medios
//   56 = Muebles
//   60 = Educación
//   70 = Servicios profesionales contratados
//   72 = Construcción, mantenimiento
//   73 = Servicios industriales
//   76 = Servicios limpieza y tratamiento
//   77 = Servicios ambientales
//   78 = Transporte, logística
//   80 = Servicios de gestión, profesionales, etc. (most common for services)
//   81 = Servicios informáticos, telecom, legales
//   82 = Publicidad, diseño
//   83 = Servicios públicos, energía
//   84 = Servicios financieros, seguros
//   85 = Servicios de salud
//   86 = Servicios educativos
//   90 = Viajes, alimentación, entretenimiento
//   91 = Servicios personales y de lavandería
//   93 = Servicios político-jurídicos
//   94 = Organizaciones
//
// Mapping below uses the COE_CODES from catalog.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { COE_CODES } from "./catalog";

export type EgresoCategory = {
  /** SAT code prefix match (2-6 chars). Longest match wins. */
  prefix: string;
  /** Target COE subcuenta code */
  cuenta: string;
  /** Human label for reports */
  label: string;
};

// Ordered by specificity — longer prefixes checked first
const MAPPING: EgresoCategory[] = [
  // ── Combustibles y lubricantes (601.48 oficial) ──────────────────────
  { prefix: "15101", cuenta: COE_CODES.COMBUSTIBLES, label: "Combustibles" },  // Diésel, gasolina
  { prefix: "15111", cuenta: COE_CODES.COMBUSTIBLES, label: "Gas" },           // Gas natural, LP
  { prefix: "1510",  cuenta: COE_CODES.COMBUSTIBLES, label: "Combustibles" },  // Otros combustibles
  { prefix: "1512",  cuenta: COE_CODES.COMBUSTIBLES, label: "Lubricantes" },   // Aceites, lubricantes

  // ── Servicios profesionales / Honorarios ─────────────────────────────
  { prefix: "80101", cuenta: COE_CODES.HONORARIOS, label: "Honorarios" },  // Business admin
  { prefix: "80111", cuenta: COE_CODES.HONORARIOS, label: "Honorarios" },  // Management consulting
  { prefix: "80121", cuenta: COE_CODES.HONORARIOS, label: "Honorarios legales" },  // Legal
  // 8013 es SERVICIOS INMOBILIARIOS, no notarías: 801315 «Alquiler y
  // arrendamiento de propiedades», 801316 «Administración de bienes raíces».
  // Estaba mapeado a honorarios notariales y en Margom eso puso $17M de RENTA
  // bajo «Servicios notariales» — un renglón que nadie iba a cuestionar porque
  // suena plausible. Las notarías son 80121 (servicios legales).
  { prefix: "80131", cuenta: COE_CODES.RENTAS, label: "Arrendamiento" },
  { prefix: "80141", cuenta: "601.61", label: "Publicidad y marketing" },  // Propaganda y publicidad
  { prefix: "80161", cuenta: COE_CODES.HONORARIOS, label: "Gestión de negocios" },
  { prefix: "80171", cuenta: COE_CODES.HONORARIOS, label: "Servicios de consultoría" },

  // ── IT / Software / Telecom ───────────────────────────────────────────
  { prefix: "81111", cuenta: "601.32", label: "Servicios de software" },   // Servicios administrativos
  { prefix: "81112", cuenta: "601.32", label: "Servicios de TI" },
  { prefix: "81161", cuenta: "601.50", label: "Teléfono, internet" },
  { prefix: "4323",  cuenta: COE_CODES.OTROS_GASTOS, label: "Equipos de cómputo (gasto)" },
  { prefix: "4620",  cuenta: COE_CODES.OTROS_GASTOS, label: "Equipos de cómputo (gasto)" },

  // ── Rentas ───────────────────────────────────────────────────────────
  { prefix: "80131601", cuenta: COE_CODES.RENTAS, label: "Arrendamiento inmueble" },
  { prefix: "80141604", cuenta: COE_CODES.RENTAS, label: "Arrendamiento" },
  { prefix: "80131603", cuenta: COE_CODES.RENTAS, label: "Arrendamiento" },

  // ── Transporte y logística (601.72 Fletes y acarreos) ────────────────
  { prefix: "7818",  cuenta: "601.72", label: "Fletes y transporte" },
  { prefix: "7810",  cuenta: "601.72", label: "Transporte de pasajeros" },
  { prefix: "7812",  cuenta: "601.72", label: "Transporte" },
  { prefix: "7814",  cuenta: "601.72", label: "Almacenaje" },

  // ── Viajes / Viáticos (601.49 Viáticos y gastos de viaje) ────────────
  { prefix: "90101", cuenta: "601.49", label: "Restaurantes / alimentación" },
  { prefix: "90111", cuenta: "601.49", label: "Hotelería" },
  { prefix: "90121", cuenta: "601.49", label: "Viajes" },
  { prefix: "78111", cuenta: "601.49", label: "Viajes (boletos aéreos)" },

  // ── Servicios públicos ───────────────────────────────────────────────
  // 831018 = servicios de energía eléctrica: es la clave que usa CFE en sus
  // CFDI reales. Sin el prefijo largo caía en 83101 y cada recibo de luz se
  // contabilizaba como AGUA.
  { prefix: "831018", cuenta: "601.52", label: "Energía eléctrica" },
  { prefix: "83101", cuenta: "601.51", label: "Agua" },
  { prefix: "83111", cuenta: "601.52", label: "Energía eléctrica" },
  { prefix: "83121", cuenta: COE_CODES.COMBUSTIBLES, label: "Gas" },

  // ── Mantenimiento / Reparaciones (601.56) ────────────────────────────
  { prefix: "7214",  cuenta: "601.56", label: "Mantenimiento" },
  { prefix: "7215",  cuenta: "601.56", label: "Reparaciones" },
  { prefix: "7216",  cuenta: "601.56", label: "Mantenimiento industrial" },
  { prefix: "7610",  cuenta: "601.54", label: "Limpieza" },

  // ── Seguros y financieros ────────────────────────────────────────────
  { prefix: "84131", cuenta: "601.57", label: "Seguros y fianzas" },
  { prefix: "84101", cuenta: "601.57", label: "Seguros y fianzas" },
  // Intereses y servicios bancarios: gasto FINANCIERO, no de operación.
  { prefix: "84121", cuenta: COE_CODES.COMISIONES_BANCARIAS, label: "Intereses y servicios bancarios" },
  // Segmento 82 = publicidad y diseño. Sin esto, cada espectacular y cada
  // paquete publicitario caía en «Otros gastos» ($6.8M en Margom).
  { prefix: "82",    cuenta: "601.61", label: "Publicidad y marketing" },
  // 8015 = mercadotecnia y promoción comercial ($10.3M en Margom).
  { prefix: "80151", cuenta: "601.61", label: "Promoción comercial" },
  // 7210 = mantenimiento y remodelación de inmuebles. Ya estaban 7214/7215/7216
  // pero no la familia que usa el proveedor de obra ($8.8M en Margom).
  { prefix: "7210",  cuenta: "601.56", label: "Mantenimiento y remodelación" },
  // Cuotas obrero-patronales facturadas (IMSS/RCV) — mismo destino que la
  // provisión de nómina, para que no aparezcan como gasto sin nombre.
  { prefix: "85101", cuenta: COE_CODES.CUOTAS_IMSS_PATRONAL, label: "Cuotas IMSS / RCV" },
  { prefix: "84121", cuenta: COE_CODES.COMISIONES_BANCARIAS, label: "Servicios bancarios" },

  // ── Material de oficina / papelería (601.55) ─────────────────────────
  { prefix: "44121", cuenta: "601.55", label: "Papelería y artículos de oficina" },
  { prefix: "14111", cuenta: "601.55", label: "Papelería" },
  { prefix: "44103", cuenta: "601.55", label: "Material de oficina" },

  // ── Nómina de terceros / Outsourcing (deprecated 2021 pero aún en CFDI) ──
  { prefix: "80161501", cuenta: COE_CODES.HONORARIOS, label: "Servicios administrativos" },

  // ── Alimentos (comedor industrial) ───────────────────────────────────
  { prefix: "5010",  cuenta: COE_CODES.OTROS_GASTOS, label: "Alimentos" },

  // ── Publicidad (601.61 Propaganda y publicidad) ──────────────────────
  { prefix: "8214",  cuenta: "601.61", label: "Publicidad" },
  { prefix: "8215",  cuenta: "601.61", label: "Publicidad" },
  { prefix: "8216",  cuenta: "601.61", label: "Diseño gráfico" },

  // ── Capacitación / Educación (601.62) ────────────────────────────────
  { prefix: "8611",  cuenta: "601.62", label: "Capacitación al personal" },
];

/**
 * Finds the best matching category for a claveProdServ. Returns the generic
 * "otros gastos" account if nothing matches.
 */
export function classifyEgreso(claveProdServ: string): { cuenta: string; label: string } {
  if (!claveProdServ) {
    return { cuenta: COE_CODES.OTROS_GASTOS, label: "Otros gastos" };
  }
  const clean = claveProdServ.trim();

  // Sort mapping by prefix length DESC so longer matches win
  const sorted = [...MAPPING].sort((a, b) => b.prefix.length - a.prefix.length);

  for (const m of sorted) {
    if (clean.startsWith(m.prefix)) {
      return { cuenta: m.cuenta, label: m.label };
    }
  }

  return { cuenta: COE_CODES.OTROS_GASTOS, label: "Otros gastos" };
}

/**
 * Classifies a whole invoice by looking at all line items. Returns the
 * classification of the line with the highest importe (the dominant one).
 * If no items → falls back to Otros gastos.
 */
export function classifyInvoice(items: Array<{ claveProdServ: string; importe: number }>): { cuenta: string; label: string } {
  if (!items || items.length === 0) {
    return { cuenta: COE_CODES.OTROS_GASTOS, label: "Otros gastos" };
  }
  // Find the dominant line
  const sorted = [...items].sort((a, b) => b.importe - a.importe);
  return classifyEgreso(sorted[0].claveProdServ);
}

// List of all extra account codes used by this classifier — used by the seeder
// to make sure every subcuenta exists in the company's chart of accounts.
export const EXTRA_ACCOUNTS_FOR_CLASSIFICATION: Array<{
  cuentaSAT: string;
  subcuenta: string;
  nombre: string;
  tipo: "GASTO";
  nivel: number;
  naturaleza?: "D" | "A";
}> = [
  // Nombres OFICIALES del código agrupador (ver codigo-agrupador.ts); el test
  // codigo-agrupador.test.ts los coteja letra por letra.
  { cuentaSAT: "601", subcuenta: "601.32", nombre: "Servicios administrativos", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.48", nombre: "Combustibles y lubricantes", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.49", nombre: "Viáticos y gastos de viaje", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.50", nombre: "Teléfono, internet", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.51", nombre: "Agua", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.52", nombre: "Energía eléctrica", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.54", nombre: "Limpieza", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.55", nombre: "Papelería y artículos de oficina", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.56", nombre: "Mantenimiento y conservación", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.57", nombre: "Seguros y fianzas", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.61", nombre: "Propaganda y publicidad", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.62", nombre: "Capacitación al personal", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.72", nombre: "Fletes y acarreos", tipo: "GASTO", nivel: 3 },
];
