import { NextResponse } from "next/server";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { asegurarConsumoJuridico } from "@/lib/juridico/consumo";
import { MAX_BYTES_AUDIO, esAudio, transcribirNota, transcripcionDisponible } from "@/lib/juridico/voz";

// POST /api/juridico/transcribir — una nota de voz a texto. Devuelve el texto
// para que el abogado lo CORRIJA antes de enviarlo; no dispara un turno.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  if (!transcripcionDisponible()) return NextResponse.json({ error: "La transcripción no está configurada en este entorno." }, { status: 503 });
  const puede = await asegurarConsumoJuridico(userId);
  if (!puede.permitido) return NextResponse.json({ error: puede.motivo, codigo: "JURIDICO_TOPE_MES", consumo: puede.consumo }, { status: 429 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Manda multipart/form-data con el campo `audio`." }, { status: 400 });
  }
  const archivo = form.get("audio");
  if (!(archivo instanceof File) || archivo.size === 0) return NextResponse.json({ error: "Falta la nota de voz (`audio`)." }, { status: 400 });
  if (archivo.size > MAX_BYTES_AUDIO) return NextResponse.json({ error: `La nota pesa más de ${MAX_BYTES_AUDIO / 1024 / 1024} MB; graba una más corta.` }, { status: 413 });
  if (!esAudio(archivo.type, archivo.name)) return NextResponse.json({ error: "Ese archivo no es audio." }, { status: 415 });

  try {
    const r = await transcribirNota(Buffer.from(await archivo.arrayBuffer()), archivo.type || "audio/ogg", { userId });
    return NextResponse.json(r);
  } catch (e) {
    return respuestaDeError(e);
  }
}
