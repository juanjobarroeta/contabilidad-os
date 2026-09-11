// ─────────────────────────────────────────────────────────────────────────────
// Tipos y constantes COMPARTIDOS por las dos listas de conciliación.
//
// Existían duplicados: la mesa (ConciliacionWorkbench) y Movimientos
// (GestionBancos) mantenían su propia versión de lo mismo y se fueron
// separando — la lista de categorías llegó a estar escrita dos veces, y cada
// función nueva aterrizaba en una sola mitad. Aquí vive una sola.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo MÍNIMO que el panel necesita saber de un movimiento para resolverlo. */
export interface MovimientoResoluble {
  id: string;
  bankAccountId: string;
  fecha: string;
  descripcion: string;
  /** Firmado: + depósito, − retiro. */
  monto: number;
  contraparteNombre?: string | null;
  contraparteClabe?: string | null;
  claveRastreo?: string | null;
}

export interface CandidatoFactura {
  id: string;
  uuid?: string;
  fecha: string;
  total: number;
  cliente: string;
  rfc: string;
  score: number;
  confidence: "alta" | "media" | "baja";
  folio?: string;
  serie?: string;
  /** PPD cobra en parcialidades: el candidato lo dice para que no sorprenda. */
  metodoPago?: string;
}

/** Comprobante Electrónico de Pago de Banxico: la prueba de que el dinero
 *  llegó a esa cuenta ese día. */
export interface CepMovimiento {
  estado: string | null;
  fechaOperacion: string | null;
  concepto: string | null;
  /** Lo que Banxico dice que se pagó — no lo que dice el estado de cuenta. */
  monto: number | null;
  ordenanteNombre: string | null;
  ordenanteRfc: string | null;
  ordenanteBanco: string | null;
  ordenanteCuenta: string | null;
  beneficiarioNombre: string | null;
  beneficiarioRfc: string | null;
  beneficiarioBanco: string | null;
  beneficiarioCuenta: string | null;
}

/** Varias facturas de la misma contraparte que suman EXACTO el movimiento. */
export interface PagoJuntoSugerido {
  rfc: string;
  cliente: string;
  suma: number;
  facturas: Array<{ invoiceId: string; monto: number; folio: string; fecha: string | null }>;
}

/** Declaración pendiente que este egreso podría estar pagando. */
export interface CandidatoImpuesto {
  id: string;
  tipo: string;
  periodo: string;
  etiqueta: string;
  montoEsperado: number | null;
  fechaLimitePago: string | null;
  score: number;
  confidence: "alta" | "media" | "baja";
}

/** Línea de la charola: factura elegida + monto asignado EDITABLE. */
export interface SeleccionFactura {
  id: string;
  label: string;
  total: number;
  monto: string;
}

/** El CFDI con el que un movimiento YA quedó cruzado, con su porción. */
export interface FacturaCruzada {
  id: string;
  uuid: string | null;
  folio: string | null;
  fecha: string;
  total: number;
  tipo: string;
  cliente: string | null;
  rfc: string | null;
  /** Lo que se aplicó de ESTE movimiento a ESA factura (1:1 = el total). */
  montoAsignado: number;
}

/** Contra qué quedó conciliado un movimiento: facturas, un pago de impuestos,
 *  o nada (sin cruzar, o categorizado sin comprobante). */
export interface CruceMovimiento {
  facturas: FacturaCruzada[];
  impuesto: { id: string; etiqueta: string; status: string } | null;
}

export interface FacturaBuscada {
  id: string;
  uuid: string | null;
  folio: string | null;
  serie: string | null;
  fecha: string;
  total: number;
  tipo: string;
  customer: { razonSocial: string; rfc: string } | null;
  matchedAmount: number;
  fullyMatched: boolean;
}

export const CONF_TONO: Record<CandidatoFactura["confidence"], "jade" | "amber" | "slate"> = {
  alta: "jade",
  media: "amber",
  baja: "slate",
};

/** Familias que se registran en el LIBRO MAYOR vía aprobarSugerencia. A
 *  diferencia de las categorías simples (que sólo ignoran + etiquetan), éstas
 *  asientan. */
export const FAMILIA_LOTE: { familia: string; label: string }[] = [
  { familia: "NON_DEDUCTIBLE", label: "No deducible" },
  { familia: "COMISION", label: "Comisiones bancarias" },
  { familia: "TAX_PAYMENT", label: "Impuestos y derechos" },
  { familia: "PAYROLL_NO_CFDI", label: "Nómina sin CFDI" },
  { familia: "RENT", label: "Renta / arrendamiento" },
  { familia: "FINANCIAL_INCOME", label: "Intereses / rendimientos" },
  { familia: "INTERNAL_TRANSFER", label: "Traspaso entre cuentas" },
];

// Ruido bancario que no distingue a un comercio (espeja el heurístico del
// servidor en reglas-categorizacion.ts). El token propuesto es editable.
const TOKEN_STOP = new Set([
  "SPEI", "PAGO", "PAGOS", "COMPRA", "CARGO", "ABONO", "TARJETA", "DEBITO", "CREDITO",
  "TRANSFERENCIA", "TRASPASO", "REFERENCIA", "REF", "FOLIO", "CLABE", "CUENTA", "BANCO",
  "COM", "MXN", "USD", "OPERACION", "AUT", "MEXICO", "MEX", "SUC", "TDD", "TDC", "INT",
  "NACIONAL", "NEGOCIO", "DIGITAL", "ONLINE", "WWW", "COMISION",
]);

/** La palabra más distintiva de la descripción, para agrupar similares. */
export function tokenDeDescripcion(desc: string): string {
  if (!desc) return "";
  const norm = desc.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const tokens = norm.split(/[^A-Z]+/).filter((t) => t.length >= 3 && !TOKEN_STOP.has(t));
  if (tokens.length === 0) return "";
  return tokens.reduce((mejor, t) => (t.length > mejor.length ? t : mejor), tokens[0]);
}

export const fmtFechaCorta = (iso: string): string => {
  const M = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, "0")} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
