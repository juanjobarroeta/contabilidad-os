import { NextResponse } from "next/server";
import { Certificate } from "@nodecfdi/credentials/node";
import { AuthzError, requireUser } from "@/lib/authz";
import { validarCredencialSat } from "@/lib/sat-fiel";
import { asegurarUsoIA, respuestaTopeIA } from "@/lib/ai/guardia";
import { parseSatDocument, type CsfData } from "@/lib/fiscal/acuse/parse";
import { SatGoClient, satGoConfigurado } from "@/lib/fiscal/cumplimiento/satgo/client";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/onboarding/fiel — la pantalla 04 del alta, ANTES de que exista la
// empresa. No guarda nada: la e.firma se guarda (cifrada) en POST
// /api/companies, que la vuelve a validar.
//
//   { accion: "leer", cer }                → RFC, razón social y vigencia del .cer
//   { accion: "validar", cer, key, password } → los tres checks (mismo validador
//                                            que el alta: tipo, vigencia, llave↔cert
//                                            y contraseña)
//   { accion: "csf", cer, key, password }  → la constancia de situación fiscal
//                                            vía SatGo con la e.firma → régimen,
//                                            CP, regímenes y obligaciones (así no
//                                            se le pregunta al usuario lo que el
//                                            SAT ya sabe)
//
// cer/key van en base64 (DER), como los manda el wizard al alta.
// ─────────────────────────────────────────────────────────────────────────────

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_B64 = 64 * 1024;

function certDe(cerB64: string): Certificate | null {
  try {
    return new Certificate(Buffer.from(cerB64, "base64").toString("binary"));
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);
    const body = (await req.json().catch(() => null)) as { accion?: string; cer?: string; key?: string; password?: string } | null;
    const cer = typeof body?.cer === "string" ? body.cer : "";
    if (!cer || cer.length > MAX_B64) return NextResponse.json({ error: "Falta el certificado (.cer)" }, { status: 400 });
    const cert = certDe(cer);
    if (!cert) return NextResponse.json({ error: "El archivo .cer no se pudo leer como certificado del SAT. Revisa que sea el .cer correcto." }, { status: 422 });

    const rfc = (cert.rfc() || "").trim().toUpperCase();
    const info = {
      rfc,
      razonSocial: (cert.legalName() || "").trim(),
      validoHasta: cert.validTo()?.toISOString() ?? null,
      esFiel: cert.satType().isFiel(),
      vigente: cert.validOn(),
    };

    if (body?.accion === "leer") return NextResponse.json(info);

    const key = typeof body?.key === "string" ? body.key : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!key || key.length > MAX_B64 || !password) {
      return NextResponse.json({ error: "Faltan la llave (.key) o la contraseña" }, { status: 400 });
    }

    if (body?.accion === "validar") {
      const v = validarCredencialSat({ cerBase64: cer, keyBase64: key, password, esperado: "FIEL" });
      // Los checks que ve el usuario. Si el tipo o la vigencia fallan, la llave
      // ni se probó: queda «sin revisar» (null), no «falló».
      const llaveProbada = info.esFiel && info.vigente;
      return NextResponse.json({
        ...info,
        ok: v.ok,
        error: v.ok ? null : v.error,
        checks: {
          esFiel: info.esFiel,
          vigente: info.vigente,
          llave: llaveProbada ? v.ok : null,
        },
      });
    }

    if (body?.accion === "csf") {
      const v = validarCredencialSat({ cerBase64: cer, keyBase64: key, password, esperado: "FIEL" });
      if (!v.ok) return NextResponse.json({ error: v.error }, { status: 422 });
      if (!satGoConfigurado()) return NextResponse.json({ datos: null, motivo: "La consulta al SAT no está disponible en este momento." });
      const guardia = await asegurarUsoIA({ userId: user.id, companyId: null });
      if (!guardia.ok) return respuestaTopeIA(guardia);
      try {
        const { data } = await new SatGoClient().consultarCsfFiel({
          rfc,
          cer: Buffer.from(cer, "base64"),
          key: Buffer.from(key, "base64"),
          pass: password,
        });
        const parsed = await parseSatDocument(data.toString("base64"), { subtipo: "onboarding.csf_fiel", userId: user.id });
        if (parsed.type !== "CSF" || !parsed.csf) return NextResponse.json({ datos: null, motivo: "El SAT no devolvió una constancia legible." });
        return NextResponse.json({ datos: datosDeCsf(parsed.csf, info.razonSocial) });
      } catch (e) {
        // El SAT/SatGo caído no bloquea el alta: el usuario confirma 2 datos.
        console.warn("[onboarding/fiel] CSF vía e.firma falló:", e instanceof Error ? e.message : e);
        return NextResponse.json({ datos: null, motivo: "El SAT no respondió con tu constancia." });
      }
    }

    return NextResponse.json({ error: "Acción inválida" }, { status: 400 });
  } catch (e) {
    if (e instanceof AuthzError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

/** Lo que POST /api/companies necesita de la CSF (mismo mapeo que el wizard manual). */
function datosDeCsf(c: CsfData, razonCert: string) {
  const regimenes = (c.regimenes ?? []).filter((r) => r.code);
  const desde = regimenes
    .map((r) => r.since)
    .filter((s): s is string => !!s && !isNaN(new Date(s).getTime()))
    .sort();
  const domicilio = [
    c.calle && c.numExterior ? `${c.calle} ${c.numExterior}` : c.calle,
    c.numInterior ? `Int. ${c.numInterior}` : null,
    c.colonia ? `Col. ${c.colonia}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return {
    razonSocial: c.razonSocial || razonCert,
    regimenFiscal: c.regimenFiscal || regimenes[0]?.code || "",
    codigoPostal: c.codigoPostal || "",
    domicilioFiscal: domicilio,
    regimenes,
    fechaInicioRegimen: desde[0] ?? null,
    csfObligaciones: c.obligaciones ?? [],
    email: c.correo ?? "",
    telefono: c.telefono ?? "",
    actividadEconomica: c.actividadEconomica ?? "",
  };
}
