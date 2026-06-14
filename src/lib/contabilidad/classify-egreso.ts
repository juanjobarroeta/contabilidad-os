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
  // ── Combustibles ─────────────────────────────────────────────────────
  { prefix: "15101", cuenta: "601.15", label: "Combustibles" },        // Diésel, gasolina
  { prefix: "15111", cuenta: "601.15", label: "Combustibles" },        // Gas natural, LP
  { prefix: "1510",  cuenta: "601.15", label: "Combustibles" },        // Otros combustibles
  { prefix: "1512",  cuenta: "601.16", label: "Lubricantes" },         // Aceites, lubricantes

  // ── Servicios profesionales / Honorarios ─────────────────────────────
  { prefix: "80101", cuenta: COE_CODES.HONORARIOS, label: "Honorarios" },  // Business admin
  { prefix: "80111", cuenta: COE_CODES.HONORARIOS, label: "Honorarios" },  // Management consulting
  { prefix: "80121", cuenta: COE_CODES.HONORARIOS, label: "Honorarios legales" },  // Legal
  { prefix: "80131", cuenta: "601.17", label: "Bienes raíces / notariales" },
  { prefix: "80141", cuenta: "601.18", label: "Publicidad y marketing" },  // Marketing
  { prefix: "80161", cuenta: COE_CODES.HONORARIOS, label: "Gestión de negocios" },
  { prefix: "80171", cuenta: COE_CODES.HONORARIOS, label: "Servicios de consultoría" },

  // ── IT / Software / Telecom ───────────────────────────────────────────
  { prefix: "81111", cuenta: "601.19", label: "Servicios de software" },
  { prefix: "81112", cuenta: "601.19", label: "Servicios de TI" },
  { prefix: "81161", cuenta: "601.20", label: "Servicios de telecomunicaciones" },
  { prefix: "4323",  cuenta: "601.21", label: "Equipos de cómputo y software" },
  { prefix: "4620",  cuenta: "601.21", label: "Equipos de cómputo" },

  // ── Rentas ───────────────────────────────────────────────────────────
  { prefix: "80131601", cuenta: COE_CODES.RENTAS, label: "Arrendamiento inmueble" },
  { prefix: "80141604", cuenta: COE_CODES.RENTAS, label: "Arrendamiento" },
  { prefix: "80131603", cuenta: COE_CODES.RENTAS, label: "Arrendamiento" },

  // ── Transporte y logística ───────────────────────────────────────────
  { prefix: "7818",  cuenta: "601.22", label: "Fletes y transporte" },
  { prefix: "7810",  cuenta: "601.22", label: "Transporte de pasajeros" },
  { prefix: "7812",  cuenta: "601.22", label: "Transporte" },
  { prefix: "7814",  cuenta: "601.22", label: "Almacenaje" },

  // ── Viajes / Viáticos ────────────────────────────────────────────────
  { prefix: "90101", cuenta: "601.23", label: "Restaurantes / alimentación" },
  { prefix: "90111", cuenta: "601.23", label: "Hotelería" },
  { prefix: "90121", cuenta: "601.24", label: "Viajes" },
  { prefix: "78111", cuenta: "601.24", label: "Viajes (boletos aéreos)" },

  // ── Servicios públicos ───────────────────────────────────────────────
  { prefix: "83101", cuenta: "601.25", label: "Agua" },
  { prefix: "83111", cuenta: "601.26", label: "Energía eléctrica" },
  { prefix: "83121", cuenta: "601.26", label: "Gas" },

  // ── Mantenimiento / Reparaciones ─────────────────────────────────────
  { prefix: "7214",  cuenta: "601.27", label: "Mantenimiento" },
  { prefix: "7215",  cuenta: "601.27", label: "Reparaciones" },
  { prefix: "7216",  cuenta: "601.27", label: "Mantenimiento industrial" },
  { prefix: "7610",  cuenta: "601.28", label: "Limpieza" },

  // ── Seguros y financieros ────────────────────────────────────────────
  { prefix: "84131", cuenta: "601.29", label: "Seguros" },
  { prefix: "84121", cuenta: "601.30", label: "Servicios bancarios" },

  // ── Material de oficina / papelería ──────────────────────────────────
  { prefix: "44121", cuenta: "601.31", label: "Papelería y material de oficina" },
  { prefix: "14111", cuenta: "601.31", label: "Papelería" },
  { prefix: "44103", cuenta: "601.31", label: "Material de oficina" },

  // ── Nómina de terceros / Outsourcing (deprecated 2021 pero aún en CFDI) ──
  { prefix: "80161501", cuenta: COE_CODES.HONORARIOS, label: "Servicios administrativos" },

  // ── Alimentos (comedor industrial) ───────────────────────────────────
  { prefix: "5010",  cuenta: "601.32", label: "Alimentos" },

  // ── Publicidad ───────────────────────────────────────────────────────
  { prefix: "8214",  cuenta: "601.18", label: "Publicidad" },
  { prefix: "8215",  cuenta: "601.18", label: "Publicidad" },
  { prefix: "8216",  cuenta: "601.18", label: "Diseño gráfico" },

  // ── Capacitación / Educación ─────────────────────────────────────────
  { prefix: "8611",  cuenta: "601.33", label: "Capacitación y educación" },
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
  { cuentaSAT: "601", subcuenta: "601.15", nombre: "Combustibles", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.16", nombre: "Lubricantes",  tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.17", nombre: "Servicios notariales y bienes raíces", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.18", nombre: "Publicidad y marketing", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.19", nombre: "Servicios de software / TI", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.20", nombre: "Telecomunicaciones", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.21", nombre: "Equipos de cómputo", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.22", nombre: "Fletes y transporte", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.23", nombre: "Hospedaje y alimentación", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.24", nombre: "Viajes", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.25", nombre: "Agua", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.26", nombre: "Energía y gas", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.27", nombre: "Mantenimiento y reparaciones", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.28", nombre: "Limpieza", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.29", nombre: "Seguros", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.30", nombre: "Servicios bancarios", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.31", nombre: "Papelería y material de oficina", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.32", nombre: "Alimentos", tipo: "GASTO", nivel: 3 },
  { cuentaSAT: "601", subcuenta: "601.33", nombre: "Capacitación y educación", tipo: "GASTO", nivel: 3 },
];
