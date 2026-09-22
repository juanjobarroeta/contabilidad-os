import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { BinaryDownload } from "facturapi";

/** Facturapi returns a Node stream, with a Blob fallback for binary responses. */
export async function readFacturapiFile(file: BinaryDownload): Promise<Buffer> {
  if (file instanceof Blob) return Buffer.from(await file.arrayBuffer());
  if (file instanceof Readable) return buffer(file);
  throw new Error("Facturapi devolvió un formato de archivo no compatible");
}
