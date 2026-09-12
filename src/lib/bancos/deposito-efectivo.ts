/**
 * ¿Este abono es dinero que ENTRÓ EN EFECTIVO antes de llegar al banco?
 *
 * Importa para el asiento. Un cobro en efectivo no va del cliente al banco: el
 * paciente paga en la caja del hospital, el dinero se queda ahí un rato y
 * alguien lo va a depositar. Son dos hechos y el libro los tiene que contar
 * como dos:
 *
 *     DR Caja            / AB Clientes     ← el cobro, que pasó en la caja
 *     DR Bancos          / AB Caja         ← el depósito, que pasó en el banco
 *
 * Postearlo como DR Bancos / AB Clientes dice que el cliente transfirió, que no
 * es lo que pasó, y deja la cuenta de Caja (101.01) en ceros para siempre — sin
 * el rastro de por dónde entró el dinero.
 *
 * CUIDADO CON «VENTAS DEL DÍA». Santander rotula las liquidaciones de TERMINAL
 * como «DEPOSITO VENTAS DEL DIA AFIL.-1234»: lleva la palabra depósito y no es
 * efectivo, es el adquirente liquidando tarjetas. Por eso el patrón exige que
 * «efectivo» aparezca pegado a «depósito», y no basta con la palabra suelta
 * («Retiro efectivo» tampoco es esto, aunque ése además es cargo).
 */
const DEPOSITO_EN_EFECTIVO = /\bDEP(?:[OÓ]SITO|\.)?\s*(?:EN\s+)?EFECTIVO\b/i;

export function esDepositoEnEfectivo(descripcion: string): boolean {
  return DEPOSITO_EN_EFECTIVO.test(descripcion);
}
