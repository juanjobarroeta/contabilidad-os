// Un error de NEGOCIO del copiloto jurídico: la operación es imposible por lo
// que dicen las reglas, no por quién pregunta.
//
// Antes todo lo que no fuera AuthzError caía en el `else` de respuestaDeError y
// salía como 401 «Unauthorized»: intentar dejar un despacho sin socio contestaba
// que no estabas autorizado, que es mentira y además esconde el motivo real.
export class ErrorJuridico extends Error {
  constructor(
    message: string,
    public status: number = 400
  ) {
    super(message);
    this.name = "ErrorJuridico";
  }
}

export const noEncontrado = (que: string) => new ErrorJuridico(`${que} no encontrado`, 404);
export const conflicto = (mensaje: string) => new ErrorJuridico(mensaje, 409);
export const prohibido = (mensaje: string) => new ErrorJuridico(mensaje, 403);

/**
 * Lo que mandó el cliente está mal formado o fuera de rango. 400, no 409: un
 * 409 dice «el estado del servidor no lo permite» y se reintenta distinto;
 * esto se corrige en la petición. La app necesita poder distinguirlos.
 */
export const invalido = (mensaje: string) => new ErrorJuridico(mensaje, 400);
