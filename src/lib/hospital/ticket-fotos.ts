// ─────────────────────────────────────────────────────────────────────────────
// Fotos del reporte de mantenimiento.
//
// «Cualquiera del hospital levanta el reporte con foto y ubicación, en el
// momento en que ve la falla» (propuesta, lámina 18). La foto no es adorno: es
// lo que evita el viaje de reconocimiento. Con la imagen, el de mantenimiento
// sabe si va con una llave o con el proveedor del aire antes de subir.
//
// Se guardan en la base, como `HospDocumento`: es el patrón del módulo y
// mantiene el respaldo en un solo lugar. Eso obliga a ser estricto con el
// tamaño — el satélite las encoge antes de subir (lado largo 1600, JPEG) y
// aquí vive el tope duro, porque un cliente puede mentir y una cámara de
// teléfono entrega 4 MB sin despeinarse.
// ─────────────────────────────────────────────────────────────────────────────

import { HospitalError } from "./errores";

/** Lo que una cámara de teléfono produce. Sin HEIC: Safari lo convierte a
 *  JPEG al capturar por `<input capture>`, y aceptarlo aquí significaría no
 *  poder pintarlo después en ningún navegador. */
export const MIMES_FOTO = ["image/jpeg", "image/png", "image/webp"] as const;

/** Tope por foto. 1600 px de lado largo en JPEG rondan 300 KB; 2 MB deja
 *  margen de sobra para una cámara generosa y sigue estando lejos de convertir
 *  la tabla en un almacén de archivos. */
export const MAX_BYTES_FOTO = 2 * 1024 * 1024;

/** Tope por ticket: una falla se explica con tres o cuatro fotos, no con un
 *  álbum. Además acota lo que pesa abrir la ficha. */
export const MAX_FOTOS_TICKET = 6;

export function validarFoto(mime: string, bytes: number): void {
  if (!(MIMES_FOTO as readonly string[]).includes(mime)) {
    throw new HospitalError(400, `Formato no admitido (${mime}). La foto tiene que ser JPEG, PNG o WebP.`);
  }
  if (!(bytes > 0)) throw new HospitalError(400, "La foto llegó vacía.");
  if (bytes > MAX_BYTES_FOTO) {
    throw new HospitalError(
      413,
      `La foto pesa ${(bytes / 1024 / 1024).toFixed(1)} MB y el tope es ${MAX_BYTES_FOTO / 1024 / 1024} MB. El teléfono debería encogerla antes de subirla.`
    );
  }
}

export function validarCupo(yaTiene: number): void {
  if (yaTiene >= MAX_FOTOS_TICKET) {
    throw new HospitalError(409, `El reporte ya tiene ${MAX_FOTOS_TICKET} fotos, que es el tope.`);
  }
}

/** Lo que se enseña en una lista: nunca los bytes. */
export function fotoResumen(f: {
  id: string;
  mime: string;
  bytes: number;
  nota: string | null;
  createdAt: Date;
}) {
  return { id: f.id, mime: f.mime, bytes: f.bytes, nota: f.nota, createdAt: f.createdAt };
}
