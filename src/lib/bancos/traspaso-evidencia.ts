// ─────────────────────────────────────────────────────────────────────────────
// ¿Es de verdad un TRASPASO ENTRE CUENTAS PROPIAS? — la evidencia, PURA.
//
// Un traspaso propio no es ingreso ni gasto: el cierre lo lava contra Bancos y
// el motor fiscal no lo ve. Por eso la etiqueta es cara cuando está mal: un
// cobro etiquetado como traspaso se sale del ISR y del IVA, y un pago a un
// tercero etiquetado como traspaso esconde un gasto. Visto en CENTRO (agosto
// 2026): 17 abonos por 29,766.80 marcados como traspaso porque caja escribió
// «TRASPASO» o «nómina» en su Excel — transferencias desde cuentas Banorte de
// personas («Devolución», «Nómina»), un depósito en efectivo y un SPEI de una
// persona. Ninguno salió de una cuenta de la empresa.
//
// La regla: una etiqueta automática de traspaso propio necesita AL MENOS UNA de
//   (a) un movimiento ESPEJO: signo contrario, mismo monto (±0.01), ±3 días, en
//       OTRA cuenta de la misma empresa;
//   (b) la cuenta de origen/destino (CLABE de la contraparte o «CUENTA: n» /
//       «CTA: n» en el concepto) es una cuenta registrada de la empresa;
//   (c) la contraparte es la empresa (RFC o razón social);
//   (d) el concepto dice literalmente «cuentas propias».
// Un depósito en EFECTIVO sólo cuenta con (a): el concepto de ventanilla no
// dice de dónde vino el dinero.
//
// Sin evidencia el movimiento se queda pendiente para la mesa. Una persona
// puede etiquetarlo a mano (es su decisión y queda en el rastro).
// ─────────────────────────────────────────────────────────────────────────────

const DIA_MS = 86_400_000;
const VENTANA_ESPEJO_DIAS = 3;

export interface MovimientoTraspaso {
  id: string;
  bankAccountId: string;
  fecha: Date;
  monto: number;
  descripcion: string;
  contraparteNombre?: string | null;
  contraparteRfc?: string | null;
  contraparteClabe?: string | null;
}

export interface ContextoTraspaso {
  empresa: { rfc: string; razonSocial: string };
  cuentas: { id: string; numeroCuenta: string | null; clabe: string | null }[];
  /** Movimientos de la empresa alrededor de la fecha, de cualquier cuenta (se filtran aquí). */
  candidatosEspejo: { id: string; bankAccountId: string; fecha: Date; monto: number }[];
}

export type ReglaTraspaso = "traspaso.espejo" | "traspaso.cuenta-propia" | "traspaso.contraparte-empresa" | "traspaso.concepto-cuentas-propias";

export interface EvidenciaTraspaso {
  tiene: boolean;
  razones: { regla: ReglaTraspaso; detalle: string }[];
  espejoId?: string;
  /** Cuentas de la contraparte que se leyeron (para preguntarle al cliente). */
  cuentasContraparte: string[];
  esEfectivo: boolean;
}

const soloDigitos = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** «DEP.EFECTIVO», «DEPOSITO EN EFECTIVO», «C02 DEPOSITO EN EFECTIVO». */
export function esDepositoEnEfectivo(descripcion: string): boolean {
  return /DEP(?:[OÓ]SITO)?\.?\s*(?:EN\s+)?EFECTIVO/i.test(descripcion);
}

/** Las cuentas de la contraparte: su CLABE y los números que el concepto trae tras «CUENTA:» o «CTA:». */
export function cuentasDeContraparte(mov: Pick<MovimientoTraspaso, "descripcion" | "contraparteClabe">): string[] {
  const deConcepto = [...mov.descripcion.matchAll(/(?:CUENTA|CTA)\s*:?\s*(\d{6,18})/gi)].map((m) => m[1]);
  return [...new Set([soloDigitos(mov.contraparteClabe), ...deConcepto].filter((d) => d.length >= 6))];
}

/**
 * ¿`d` es una de las cuentas registradas? Igualdad exacta, o un número de
 * cuenta contenido en una CLABE (la CLABE de 18 dígitos lleva dentro el número
 * de cuenta: Banorte 1358620258 ↔ 072650013586202580).
 */
function esCuentaRegistrada(d: string, propias: string[]): boolean {
  return propias.some(
    (p) => p === d || (p.length === 18 && d.length >= 8 && p.includes(d)) || (d.length === 18 && p.length >= 8 && d.includes(p)),
  );
}

export function evidenciaTraspaso(mov: MovimientoTraspaso, ctx: ContextoTraspaso): EvidenciaTraspaso {
  const razones: EvidenciaTraspaso["razones"] = [];
  const esEfectivo = esDepositoEnEfectivo(mov.descripcion);
  const cuentasContraparte = cuentasDeContraparte(mov);

  // (a) Espejo: signo contrario, mismo monto, ±3 días, en OTRA cuenta propia.
  const cuentasPropiasIds = new Set(ctx.cuentas.map((c) => c.id));
  const espejo = ctx.candidatosEspejo
    .filter(
      (c) =>
        c.id !== mov.id &&
        c.bankAccountId !== mov.bankAccountId &&
        cuentasPropiasIds.has(c.bankAccountId) &&
        Math.sign(c.monto) === -Math.sign(mov.monto) &&
        Math.abs(Math.abs(c.monto) - Math.abs(mov.monto)) <= 0.01 &&
        Math.abs(c.fecha.getTime() - mov.fecha.getTime()) <= VENTANA_ESPEJO_DIAS * DIA_MS,
    )
    .sort((x, y) => Math.abs(x.fecha.getTime() - mov.fecha.getTime()) - Math.abs(y.fecha.getTime() - mov.fecha.getTime()))[0];
  if (espejo) {
    razones.push({
      regla: "traspaso.espejo",
      detalle: `movimiento espejo de ${Math.abs(espejo.monto).toFixed(2)} en otra cuenta de la empresa el ${espejo.fecha.toISOString().slice(0, 10)}`,
    });
  }

  if (!esEfectivo) {
    // (b) Cuenta de la contraparte registrada como de la empresa.
    const propias = ctx.cuentas.flatMap((c) => [soloDigitos(c.numeroCuenta), soloDigitos(c.clabe)]).filter((d) => d.length >= 6);
    const propia = cuentasContraparte.find((d) => esCuentaRegistrada(d, propias));
    if (propia) razones.push({ regla: "traspaso.cuenta-propia", detalle: `la cuenta ${propia} está registrada como de la empresa` });

    // (c) La contraparte es la empresa.
    const rfc = mov.contraparteRfc?.trim().toUpperCase();
    const empresaRfc = ctx.empresa.rfc.trim().toUpperCase();
    const nombreEmpresa = norm(ctx.empresa.razonSocial).split(" ").slice(0, 3).join(" ");
    if (rfc && rfc === empresaRfc) {
      razones.push({ regla: "traspaso.contraparte-empresa", detalle: "el RFC de la contraparte es el de la empresa" });
    } else if (mov.contraparteNombre && nombreEmpresa.split(" ").length >= 2 && norm(mov.contraparteNombre).startsWith(nombreEmpresa)) {
      razones.push({ regla: "traspaso.contraparte-empresa", detalle: "la contraparte es la propia razón social" });
    }

    // (d) El concepto lo dice.
    if (/CUENTAS?\s+PROPIAS?/i.test(mov.descripcion)) {
      razones.push({ regla: "traspaso.concepto-cuentas-propias", detalle: "el concepto dice «cuentas propias»" });
    }
  }

  return { tiene: razones.length > 0, razones, espejoId: espejo?.id, cuentasContraparte, esEfectivo };
}

/** Por qué NO hay evidencia, en una frase para el rastro y la mesa. */
export function motivoSinEvidencia(ev: EvidenciaTraspaso): string {
  if (ev.esEfectivo) return "depósito en efectivo sin movimiento espejo en otra cuenta de la empresa";
  if (ev.cuentasContraparte.length) {
    return `la cuenta de la contraparte (${ev.cuentasContraparte.join(", ")}) no es de la empresa y no hay movimiento espejo`;
  }
  return "sin movimiento espejo, cuenta propia, contraparte de la empresa ni «cuentas propias» en el concepto";
}
