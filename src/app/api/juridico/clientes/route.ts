import { NextResponse } from "next/server";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { candidatos, crearCliente, listarClientes } from "@/lib/juridico/clientes";

// GET /api/juridico/clientes?q= — el directorio del despacho.
// POST — alta. Con { comprobar: true } sólo devuelve posibles duplicados.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const url = new URL(req.url);
  return NextResponse.json({ clientes: await listarClientes(userId, { busqueda: url.searchParams.get("q") ?? undefined, limite: Number(url.searchParams.get("limite") ?? "50") || 50 }) });
}

export async function POST(req: Request) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const datos = {
    nombre: String(body.nombre ?? ""),
    tipoPersona: body.tipoPersona === "moral" ? ("moral" as const) : ("fisica" as const),
    rfc: typeof body.rfc === "string" ? body.rfc : null,
    curp: typeof body.curp === "string" ? body.curp : null,
    domicilio: typeof body.domicilio === "string" ? body.domicilio : null,
    representante: typeof body.representante === "string" ? body.representante : null,
    email: typeof body.email === "string" ? body.email : null,
    telefono: typeof body.telefono === "string" ? body.telefono : null,
    notas: typeof body.notas === "string" ? body.notas : null,
    // Capturado a mano en el directorio: se da por verificado salvo que digan lo contrario.
    verificado: body.verificado === false ? false : true,
  };
  try {
    const posibles = await candidatos(userId, datos);
    if (body.comprobar === true) return NextResponse.json({ candidatos: posibles });
    if (posibles.length > 0 && body.forzar !== true) {
      return NextResponse.json({ error: "Ya hay una ficha que podría ser la misma persona.", candidatos: posibles }, { status: 409 });
    }
    const c = await crearCliente(userId, datos, { userId }, typeof body.casoId === "string" ? body.casoId : null);
    return NextResponse.json(c, { status: 201 });
  } catch (e) {
    return respuestaDeError(e);
  }
}
