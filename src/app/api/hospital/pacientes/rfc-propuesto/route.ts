/**
 * GET /api/hospital/pacientes/rfc-propuesto?companyId=&nombre=&apellidoPaterno=[&apellidoMaterno=]&fechaNacimiento=AAAA-MM-DD
 *
 * El RFC que sale del nombre y la fecha con el algoritmo del SAT, para que la
 * captura lo PROPONGA en vez de pedir que alguien lo teclee. Con la CURP ya
 * capturada, teclear trece caracteres a mano es pedirle al usuario que repita
 * un dato que el sistema puede derivar — y equivocarse en uno.
 *
 * Es una PROPUESTA, nunca una verificación. La homoclave la asigna el SAT y
 * ante homonimia —mismo nombre, misma fecha— le toca una distinta a cada
 * quien. El algoritmo acierta en el caso normal (verificado contra los
 * pacientes que ya traían RFC en la ficha: coincide completo, homoclave y
 * dígito incluidos), pero sólo la constancia lo confirma. Por eso se guarda
 * con `rfcFuente: CALCULADO` y no se trata como dato bueno hasta que llegue
 * la CSF.
 *
 * Vive en el hub porque el algoritmo vive en el hub: el satélite sólo tiene lo
 * que puede decidir sin preguntar (formato y cruce CURP↔RFC). Duplicarlo allá
 * es exactamente cómo se separan dos copias de la misma regla.
 */

import { NextResponse } from "next/server";
import { requireMembership, requireModule } from "@/lib/authz";
import { withHospital } from "@/lib/hospital/with-hospital";
import { error } from "@/lib/hospital/http";
import { calcularRfc } from "@/lib/hospital/identidad";

export const GET = withHospital(async (req: Request) => {
  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("companyId");
  if (!companyId) return error("companyId requerido");

  await requireMembership(companyId, undefined, req);
  await requireModule(companyId, "HOSPITAL", req);

  const nombre = searchParams.get("nombre") ?? "";
  const apellidoPaterno = searchParams.get("apellidoPaterno") ?? "";
  const apellidoMaterno = searchParams.get("apellidoMaterno");
  const fechaNacimiento = searchParams.get("fechaNacimiento") ?? "";
  if (!nombre.trim() || !apellidoPaterno.trim() || !fechaNacimiento.trim()) {
    // Faltan datos para proponer: no es un error de la captura, es que
    // todavía no hay con qué. La pantalla simplemente no propone nada.
    return NextResponse.json({ rfc: null, motivo: "Falta nombre, apellido paterno o fecha de nacimiento" });
  }

  const r = calcularRfc({ nombres: nombre, primerApellido: apellidoPaterno, segundoApellido: apellidoMaterno, fechaNacimiento });
  return NextResponse.json(r.ok ? { rfc: r.rfc, motivo: null } : { rfc: null, motivo: r.error });
});
