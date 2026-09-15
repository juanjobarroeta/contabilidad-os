import { NextResponse } from "next/server";
import { autorizarJuridico, respuestaDeError } from "@/lib/juridico/api-guardia";
import { asegurarDespacho, listarMiembros, puede } from "@/lib/juridico/despacho";
import { DIAS_DE_PRUEBA, DOCUMENTOS_DE_PRUEBA, DOCUMENTOS_INCLUIDOS, estadoSuscripcion } from "@/lib/juridico/suscripcion";

// GET /api/juridico/suscripcion — en qué va el despacho: prueba o plan, qué
// queda, cuántos documentos lleva y cuántos asientos ocupa.
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  let userId: string;
  try {
    userId = await autorizarJuridico(req);
  } catch (e) {
    return respuestaDeError(e);
  }
  const d = await asegurarDespacho(userId);
  const [estado, miembros] = await Promise.all([estadoSuscripcion(d.despachoId), listarMiembros(d.despachoId)]);
  return NextResponse.json({
    despacho: d,
    estado,
    miembrosActivos: miembros.length,
    puedoPagar: puede(d.rol, "administrarDespacho"),
    condiciones: { diasDePrueba: DIAS_DE_PRUEBA, documentosDePrueba: DOCUMENTOS_DE_PRUEBA, documentosIncluidosPorAsiento: DOCUMENTOS_INCLUIDOS },
  });
}
