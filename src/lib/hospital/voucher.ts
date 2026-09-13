// ─────────────────────────────────────────────────────────────────────────────
// El voucher de la terminal, leído de una foto. PURO.
//
// POR QUÉ EXISTE. Hoy nadie anota a qué factura corresponde cada deslizada. El
// estado de cuenta sólo dice «HOSP HALTUS 09992889D $47,669.88» —un lote de
// varias ventas— y un mes después alguien reconstruye en Excel qué paciente
// pagó cada parte. Eso es lo que produjo las conciliaciones equivocadas de
// agosto: sin contraparte, el matcher empareja por monto y fecha, y un
// depósito de $30,000 se casó con la factura de otro paciente.
//
// El dato existe en el momento del cobro y sólo ahí: la cajera tiene enfrente
// al paciente, el voucher en la mano y sabe de qué es. Capturarlo entonces
// cuesta una foto; reconstruirlo después cuesta un mes y sale mal.
//
// NADA DE ESTO SE APLICA SOLO. Se propone y la cajera confirma. La diferencia
// con la conciliación automática es que aquí hay una persona que SABE la
// respuesta parada frente a la caja — no hay que adivinar, hay que preguntar
// bien y no hacerla teclear.
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que se alcanza a leer de un voucher. Todo opcional: un ticket arrugado
 *  da lo que da, y es mejor proponer con la mitad que exigir la captura. */
export interface VoucherLeido {
  /** Importe de la operación. Sin esto no hay nada que proponer. */
  monto: number | null;
  /** Fecha de OPERACIÓN del voucher (AAAA-MM-DD), no la de captura. */
  fecha: string | null;
  /** Afiliación de la terminal: la llave contra el estado de cuenta. */
  afiliacion: string | null;
  autorizacion: string | null;
  ultimos4: string | null;
  marca: "VISA" | "MASTERCARD" | "AMEX" | "CARNET" | "OTRA" | null;
  tipoTarjeta: "CREDITO" | "DEBITO" | null;
  /** Nombre del tarjetahabiente, cuando el voucher lo imprime. */
  tarjetahabiente: string | null;
}

/** Una factura contra la que el cobro podría ir. */
export interface CandidatoFactura {
  invoiceId: string;
  folio: string | null;
  uuid: string | null;
  /** Total del CFDI. */
  total: number;
  /** Lo ya aplicado (1:1 + detalles). El saldo es total - cobrado. */
  cobrado: number;
  fecha: string;
  receptorNombre: string | null;
  receptorRfc: string | null;
}

export interface Propuesta extends CandidatoFactura {
  saldo: number;
  puntos: number;
  /** Por qué se propone, en palabras que la cajera pueda verificar de un vistazo. */
  razones: string[];
}

const CENT = 0.01;
const DIA = 86_400_000;

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Normaliza un nombre para comparar: sin acentos, sin puntuación, mayúsculas. */
export function normalizarNombre(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ¿El nombre del tarjetahabiente y el del receptor son la misma persona?
 *
 * Los vouchers imprimen «GONZALEZ RUIZ/ROSA M» y el CFDI dice «ROSA MARIA
 * GONZALEZ RUIZ»: distinto orden, apellidos primero, nombre abreviado. Se
 * comparan los APELLIDOS como conjunto porque son lo estable; el nombre de pila
 * viene truncado demasiado seguido como para exigirlo.
 */
export function mismoTitular(tarjetahabiente: string | null, receptor: string | null): boolean {
  const a = normalizarNombre(tarjetahabiente).split(" ").filter((p) => p.length > 2);
  const b = normalizarNombre(receptor).split(" ").filter((p) => p.length > 2);
  if (a.length === 0 || b.length === 0) return false;
  const comunes = a.filter((p) => b.includes(p));
  return comunes.length >= 2 || (comunes.length === 1 && a.length === 1);
}

/**
 * Las facturas que podrían corresponder a este voucher, ordenadas.
 *
 * El orden de las señales NO es arbitrario. El nombre del tarjetahabiente
 * identifica a una PERSONA y por eso vale más que cualquier coincidencia de
 * cifras; el monto contra el saldo confirma. Al revés —monto primero— es
 * exactamente cómo la conciliación automática acabó pagando la factura de un
 * paciente con el traspaso de otro.
 *
 * Un empate de monto sin nadie que lo respalde se propone igual, pero de
 * último y diciéndolo: «mismo importe» es una pista, no una identificación.
 */
export function proponerFacturas(v: VoucherLeido, candidatos: CandidatoFactura[]): Propuesta[] {
  if (v.monto == null || v.monto <= 0) return [];
  const monto = r2(v.monto);
  const cuando = v.fecha ? Date.parse(`${v.fecha}T12:00:00Z`) : null;

  const out: Propuesta[] = [];
  for (const c of candidatos) {
    const saldo = r2(c.total - c.cobrado);
    if (saldo <= CENT) continue; // ya cobrada: no se propone

    let puntos = 0;
    const razones: string[] = [];

    if (mismoTitular(v.tarjetahabiente, c.receptorNombre)) {
      puntos += 120;
      razones.push(`la tarjeta va a nombre de ${c.receptorNombre}`);
    }

    if (Math.abs(saldo - monto) < CENT) {
      puntos += 100;
      razones.push("el importe es exactamente el saldo");
    } else if (Math.abs(c.total - monto) < CENT) {
      puntos += 80;
      razones.push("el importe es exactamente el total");
    } else if (monto < saldo) {
      puntos += 25;
      razones.push(`abona ${((monto / saldo) * 100).toFixed(0)} % del saldo`);
    } else {
      // El cobro excede lo que esta factura debe: cabe, pero mal.
      puntos += 5;
      razones.push("el importe pasa del saldo");
    }

    if (cuando != null) {
      const dias = Math.abs(Date.parse(`${c.fecha}T12:00:00Z`) - cuando) / DIA;
      if (dias < 1) { puntos += 30; razones.push("misma fecha"); }
      else if (dias <= 3) { puntos += 15; razones.push(`${Math.round(dias)} día(s) de diferencia`); }
      else if (dias <= 30) puntos += 5;
    }

    out.push({ ...c, saldo, puntos, razones });
  }

  return out.sort((a, b) => b.puntos - a.puntos || b.fecha.localeCompare(a.fecha));
}

/**
 * ¿La propuesta de arriba es lo bastante sólida para preseleccionarla?
 *
 * Preseleccionar es poner el cursor, no aplicar: la cajera sigue teniendo que
 * confirmar. Aun así se exige identidad de la persona O un empate de saldo con
 * ventaja clara sobre la segunda, porque una preselección cómoda es una que se
 * acepta sin leer.
 */
export function esPropuestaFirme(propuestas: Propuesta[]): boolean {
  const [uno, dos] = propuestas;
  if (!uno) return false;
  if (uno.puntos < 100) return false;
  return !dos || uno.puntos - dos.puntos >= 40;
}
