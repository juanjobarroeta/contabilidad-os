/**
 * Evidencia bancaria para las pólizas del Anexo 24.
 *
 * El XSD de PolizasPeriodo exige el nodo Transferencia (o Cheque) cuando la
 * póliza mueve recursos bancarios — con banco origen/destino del catálogo
 * c_Banco del SAT, cuenta, fecha, beneficiario, RFC y monto. Los códigos de
 * c_Banco son los mismos tres dígitos con los que empieza toda CLABE, así que
 * la evidencia se deriva de datos que ya guardamos (BankAccount.clabe,
 * BankTransaction.contraparteClabe / contraparteBanco) — nunca se inventa.
 *
 * Cuando un lado no se puede resolver honestamente, NO se emite el nodo y el
 * generador lo reporta como diagnóstico (pólizas sin evidencia bancaria) para
 * que sea visible, no silencioso.
 */

/** RFC genérico del SAT para terceros no identificados (público en general). */
export const RFC_PUBLICO_GENERAL = "XAXX010101000";

/** Nombres comunes de banco → código c_Banco (fallback cuando no hay CLABE). */
const CODIGO_POR_NOMBRE: Record<string, string> = {
  banamex: "002",
  citibanamex: "002",
  bancomext: "006",
  banobras: "009",
  bbva: "012",
  bancomer: "012",
  santander: "014",
  banjercito: "019",
  hsbc: "021",
  bajio: "030",
  banbajio: "030",
  inbursa: "036",
  mifel: "042",
  scotiabank: "044",
  banregio: "058",
  invex: "059",
  afirme: "062",
  banorte: "072",
  actinver: "133",
  intercam: "136",
  bancoppel: "137",
  azteca: "127",
  "banco azteca": "127",
  compartamos: "130",
  monex: "112",
  ve_por_mas: "113",
  bx_mas: "113",
};

/** Código c_Banco desde una CLABE (los primeros 3 dígitos SON el código). */
export function codigoBancoDesdeClabe(clabe: string | null | undefined): string | null {
  if (!clabe) return null;
  const limpia = clabe.replace(/\s+/g, "");
  if (!/^\d{18}$/.test(limpia)) return null;
  return limpia.slice(0, 3);
}

/**
 * Código c_Banco desde el campo libre `contraparteBanco` ("012 BBVA MEXICO")
 * o desde un nombre de banco ("BBVA").
 */
export function codigoBancoDesdeNombre(texto: string | null | undefined): string | null {
  if (!texto) return null;
  const t = texto.trim().toLowerCase();
  const prefijo = /^(\d{3})\b/.exec(t);
  if (prefijo) return prefijo[1];
  for (const [nombre, codigo] of Object.entries(CODIGO_POR_NOMBRE)) {
    if (t.includes(nombre)) return codigo;
  }
  return null;
}

export interface TransferenciaInput {
  ctaOri: string | null;
  bancoOriNal: string;
  ctaDest: string;
  bancoDestNal: string;
  fecha: string; // YYYY-MM-DD
  benef: string;
  rfc: string;
  monto: number;
}

export interface TxParaEvidencia {
  monto: number; // >0 entrada (cobro), <0 salida (pago)
  fecha: Date;
  contraparteNombre: string | null;
  contraparteRfc: string | null;
  contraparteClabe: string | null;
  contraparteBanco: string | null;
  cuenta: {
    banco: string;
    numeroCuenta: string;
    clabe: string | null;
  };
}

/**
 * Construye el nodo Transferencia de un movimiento bancario, o null cuando no
 * se puede resolver el banco de ambos lados con datos reales.
 *
 * Dirección: entrada (cobro) → origen = contraparte, destino = cuenta propia;
 * salida (pago) → origen = cuenta propia, destino = contraparte.
 * `rfcTercero` permite pasar el RFC resuelto del CFDI ligado (mejor evidencia
 * que el extraído de la descripción SPEI). El RFC del nodo siempre es el del
 * TERCERO (así lo define el XSD); Benef es quien recibe los recursos.
 */
export function transferenciaParaTx(
  tx: TxParaEvidencia,
  opts?: { rfcTercero?: string | null; razonSocialPropia?: string | null }
): TransferenciaInput | null {
  const propioCodigo =
    codigoBancoDesdeClabe(tx.cuenta.clabe) ?? codigoBancoDesdeNombre(tx.cuenta.banco);
  const contraparteCodigo =
    codigoBancoDesdeClabe(tx.contraparteClabe) ?? codigoBancoDesdeNombre(tx.contraparteBanco);
  if (!propioCodigo || !contraparteCodigo) return null;

  const propiaCta = tx.cuenta.clabe?.replace(/\s+/g, "") || tx.cuenta.numeroCuenta;
  const contraparteCta = tx.contraparteClabe?.replace(/\s+/g, "") ?? null;
  const esEntrada = tx.monto > 0;

  // CtaDest es requerido por el XSD; sin cuenta destino real no hay nodo honesto.
  const ctaDest = esEntrada ? propiaCta : contraparteCta;
  if (!ctaDest) return null;

  return {
    ctaOri: esEntrada ? contraparteCta : propiaCta,
    bancoOriNal: esEntrada ? contraparteCodigo : propioCodigo,
    ctaDest,
    bancoDestNal: esEntrada ? propioCodigo : contraparteCodigo,
    fecha: tx.fecha.toISOString().slice(0, 10),
    benef: esEntrada
      ? opts?.razonSocialPropia ?? "Cuenta propia"
      : tx.contraparteNombre ?? "No identificado",
    rfc: opts?.rfcTercero ?? tx.contraparteRfc ?? RFC_PUBLICO_GENERAL,
    monto: Math.abs(tx.monto),
  };
}
