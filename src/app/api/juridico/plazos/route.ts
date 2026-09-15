import { NextResponse } from "next/server";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { plazosProximos } from "@/lib/juridico/plazos-datos";

// GET /api/juridico/plazos?dias=30 — lo que vence pronto en TODOS los casos
// que alcanza esta persona. Es la pantalla que se abre en la mañana.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const dias = Number(new URL(req.url).searchParams.get("dias") ?? 30);
  return NextResponse.json({ plazos: await plazosProximos(userId, { dias: Number.isFinite(dias) ? dias : 30 }) });
}
