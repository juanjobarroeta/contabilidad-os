import { NextResponse } from "next/server";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { consumoDelMes } from "@/lib/juridico/consumo";

// GET /api/juridico/consumo — lo que lleva gastado el asiento este mes, su
// tope y en qué se fue. Lo pinta el satélite en el pie del cajón.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  return NextResponse.json(await consumoDelMes(userId));
}
