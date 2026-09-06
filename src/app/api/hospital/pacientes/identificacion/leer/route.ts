/**
 * POST /api/hospital/pacientes/identificacion/leer { companyId, archivoBase64, mime, tipo?: INE|PASAPORTE|LICENCIA|CSF }
 *
 * Lee una identificación (foto JPG/PNG/WebP de INE, pasaporte, licencia) o
 * una Constancia de Situación Fiscal (PDF) con el modelo de visión del hub y
 * devuelve los campos para pre-llenar la ficha:
 *   { tipo, campos: { nombres, apellidoPaterno, apellidoMaterno, curp, rfc, fechaNacimiento, sexo,
 *     entidadNacimientoClave (DGIS «21»), entidadNacimientoCurp («PL»), nacionalidad, identificacionNumero,
 *     identificacionVigencia, domicilio: { calle, numeroExterior, numeroInterior, colonia, municipio, estado, codigoPostal } },
 *     confianza: 0-1, advertencias[] }
 * Toda CURP leída pasa por validarCurp y todo RFC por validarRfc (estructura y
 * dígito); las inconsistencias van en `advertencias`, no se corrigen solas.
 *
 * NO guarda la imagen: el satélite la adjunta después como documento
 * IDENTIFICACION (…/documentos/[docId]/archivo). El archivo se manda a la API
 * de Anthropic y se procesa de forma efímera; el gasto queda medido
 * (meteredCreate) y acotado por la guardia de IA de la empresa.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { requireModule, requireWriter } from "@/lib/authz";
import { meteredCreate } from "@/lib/costos/anthropic";
import { asegurarUsoIA, respuestaTopeIA } from "@/lib/ai/guardia";
import { validarRfc } from "@/lib/fiscal/verificador/estructura";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { validarCurp } from "@/lib/hospital/curp";
import { ENTIDAD_DGIS_POR_CURP, RFC_GENERICOS, entidadCurpDe, sexoCurpDe } from "@/lib/hospital/identidad";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 10 * 1024 * 1024;
const MIMES_IMAGEN = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;

const schema = z.object({
  companyId: z.string().min(1),
  archivoBase64: z.string().min(1),
  mime: z.enum([...MIMES_IMAGEN, "application/pdf"]),
  tipo: z.enum(["INE", "PASAPORTE", "LICENCIA", "CSF"]).optional(),
});

const SYSTEM_PROMPT = `Eres un asistente de admisión hospitalaria en México. Extraes datos de identificación de un documento (INE/IFE, pasaporte, licencia de conducir o Constancia de Situación Fiscal del SAT) para pre-llenar la ficha de un paciente.

REGLAS:
1. Devuelve SOLO un objeto JSON válido, sin markdown ni explicaciones.
2. Si un campo no aparece con claridad, devuelve null. NO inventes ni completes valores.
3. Transcribe la CURP (18 caracteres) y el RFC (13 caracteres para persona física) tal como aparecen, en mayúsculas.
4. Fechas en formato AAAA-MM-DD. La vigencia de la INE suele ser sólo un año ("VIGENCIA 2031"): devuelve "2031-12-31".
5. sexo: "H" (hombre), "M" (mujer) o "X"; en la INE aparece como SEXO H/M.
6. identificacionNumero: INE → la CLAVE DE ELECTOR (18 caracteres); pasaporte → número de pasaporte; licencia → número de licencia; CSF → el RFC.
7. entidadNacimiento: el estado de nacimiento tal como se lea (nombre o abreviatura); si no aparece, null.
8. nacionalidad: "MEX" para mexicanos; para extranjeros el código ISO de tres letras del país si se puede inferir del pasaporte.
9. domicilio: sólo lo que esté impreso; codigoPostal de 5 dígitos.
10. confianza: número entre 0 y 1 según la legibilidad del documento.

SCHEMA DE RESPUESTA (exactamente estos campos):
{
  "tipo": "INE" | "PASAPORTE" | "LICENCIA" | "CSF" | "OTRO" | null,
  "nombres": string | null,
  "apellidoPaterno": string | null,
  "apellidoMaterno": string | null,
  "curp": string | null,
  "rfc": string | null,
  "fechaNacimiento": string | null,
  "sexo": "H" | "M" | "X" | null,
  "entidadNacimiento": string | null,
  "nacionalidad": string | null,
  "identificacionNumero": string | null,
  "identificacionVigencia": string | null,
  "domicilio": { "calle": string | null, "numeroExterior": string | null, "numeroInterior": string | null, "colonia": string | null, "municipio": string | null, "estado": string | null, "codigoPostal": string | null },
  "confianza": number,
  "notas": string | null
}
Usa "notas" (español, 1-2 líneas) si algo fue difícil de leer o el documento parece incompleto, borroso o no es una identificación.`;

type Extraido = {
  tipo?: string | null;
  nombres?: string | null;
  apellidoPaterno?: string | null;
  apellidoMaterno?: string | null;
  curp?: string | null;
  rfc?: string | null;
  fechaNacimiento?: string | null;
  sexo?: string | null;
  entidadNacimiento?: string | null;
  nacionalidad?: string | null;
  identificacionNumero?: string | null;
  identificacionVigencia?: string | null;
  domicilio?: { calle?: string | null; numeroExterior?: string | null; numeroInterior?: string | null; colonia?: string | null; municipio?: string | null; estado?: string | null; codigoPostal?: string | null } | null;
  confianza?: number | null;
  notas?: string | null;
};

const texto = (v: unknown, max = 200): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** «2031» → «2031-12-31»; «AAAA-MM-DD» válido tal cual; lo demás null. */
function fechaIso(v: unknown): string | null {
  const s = texto(v, 20);
  if (!s) return null;
  if (/^\d{4}$/.test(s)) return `${s}-12-31`;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

export const POST = withHospital(async (req: Request) => {
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return errorZod(parsed.error);
  const { companyId, mime } = parsed.data;

  const { user } = await requireWriter(companyId, req);
  await requireModule(companyId, "HOSPITAL", req);

  const guardia = await asegurarUsoIA({ userId: user.id, companyId });
  if (!guardia.ok) return respuestaTopeIA(guardia);
  if (!process.env.ANTHROPIC_API_KEY) return error("La lectura de identificaciones con IA no está configurada en este servidor", 503);

  const base64 = parsed.data.archivoBase64.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return error("archivoBase64 no es base64 válido");
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_BYTES) return error(`El archivo pesa ${(bytes / 1048576).toFixed(1)} MB; el máximo es 10 MB`, 413);

  const esPdf = mime === "application/pdf";
  const tipoPedido = parsed.data.tipo ?? (esPdf ? "CSF" : undefined);
  const bloque: Anthropic.ContentBlockParam = esPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mime as (typeof MIMES_IMAGEN)[number], data: base64 } };

  let respuesta = "";
  try {
    const anthropic = new Anthropic();
    const msg = await meteredCreate(anthropic, { subtipo: "hospital.identificacion.leer", userId: user.id, companyId }, {
      model: "claude-opus-5",
      max_tokens: 2048,
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [bloque, { type: "text", text: `Extrae los datos de este documento${tipoPedido ? ` (se espera un(a) ${tipoPedido})` : ""} siguiendo el schema exacto. Sólo JSON.` }],
        },
      ],
    });
    if (msg.stop_reason === "refusal") return error("El modelo no procesó el documento; captura los datos a mano", 422);
    respuesta = msg.content.find((b) => b.type === "text")?.text ?? "";
  } catch (e) {
    console.error("[hospital.identificacion.leer] error del modelo:", e instanceof Error ? e.message : e);
    return error("No se pudo leer el documento con IA; captura los datos a mano", 502);
  }

  let extraido: Extraido;
  try {
    extraido = JSON.parse(respuesta.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim());
  } catch {
    return error("La lectura no devolvió datos legibles; captura los datos a mano", 502);
  }
  if (!extraido || typeof extraido !== "object") return error("La lectura no devolvió datos legibles; captura los datos a mano", 502);

  const advertencias: string[] = [];
  if (extraido.notas) advertencias.push(texto(extraido.notas, 300)!);

  // CURP: siempre por validarCurp; lo que diga se cruza con lo leído.
  const curpLeida = texto(extraido.curp, 30)?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? null;
  const curpR = curpLeida ? validarCurp(curpLeida) : null;
  const curpValida = !!curpR?.valida;
  if (curpLeida && !curpValida) advertencias.push(`La CURP leída (${curpLeida}) no pasa la validación: ${curpR?.motivo ?? "revísala"}`);

  let fechaNacimiento = fechaIso(extraido.fechaNacimiento);
  let sexo = sexoCurpDe(extraido.sexo);
  if (curpR?.valida && curpR.fechaNacimiento) {
    const deCurp = curpR.fechaNacimiento.toISOString().slice(0, 10);
    if (fechaNacimiento && fechaNacimiento !== deCurp) advertencias.push(`La fecha de nacimiento leída (${fechaNacimiento}) no coincide con la de la CURP (${deCurp})`);
    fechaNacimiento ??= deCurp;
    const sexoCurp = curpR.sexo === "MASCULINO" ? "H" : "M";
    if (sexo && sexo !== sexoCurp) advertencias.push(`El sexo leído (${sexo}) no coincide con el de la CURP (${sexoCurp})`);
    sexo ??= sexoCurp;
  }
  const entidadCurp = entidadCurpDe(texto(extraido.entidadNacimiento)) ?? (curpValida ? curpLeida!.slice(11, 13) : null);
  if (curpValida && entidadCurp && entidadCurp !== curpLeida!.slice(11, 13)) advertencias.push(`La entidad de nacimiento leída (${entidadCurp}) no coincide con la de la CURP (${curpLeida!.slice(11, 13)})`);

  // RFC: estructura y dígito; genérico sólo si es el del SAT.
  const rfcLeido = texto(extraido.rfc, 20)?.toUpperCase().replace(/[^A-Z0-9&Ñ]/g, "") ?? null;
  let rfcValido = false;
  if (rfcLeido) {
    const v = validarRfc(rfcLeido);
    rfcValido = RFC_GENERICOS.has(rfcLeido) || (v.formatoValido && v.digitoVerificador === "valido");
    if (!rfcValido) advertencias.push(`El RFC leído (${rfcLeido}) no pasa la validación: ${v.detalle ?? "revísalo"}`);
    if (rfcValido && curpValida && rfcLeido.length === 13 && rfcLeido.slice(4, 10) !== curpLeida!.slice(4, 10)) advertencias.push("La fecha del RFC no coincide con la de la CURP");
  }

  const tipoLeido = texto(extraido.tipo, 20)?.toUpperCase();
  const tipo = tipoPedido ?? (tipoLeido && ["INE", "PASAPORTE", "LICENCIA", "CSF", "OTRO"].includes(tipoLeido) ? tipoLeido : "OTRO");
  if (tipoPedido && tipoLeido && tipoLeido !== tipoPedido && tipoLeido !== "OTRO") advertencias.push(`Se esperaba ${tipoPedido} y el documento parece ${tipoLeido}`);
  const confianza = typeof extraido.confianza === "number" && Number.isFinite(extraido.confianza) ? Math.min(1, Math.max(0, extraido.confianza)) : 0.5;
  if (confianza < 0.6) advertencias.push("Lectura poco confiable: verifica cada campo contra el documento");
  const dom = extraido.domicilio && typeof extraido.domicilio === "object" ? extraido.domicilio : {};
  const codigoPostal = texto(dom.codigoPostal, 10)?.replace(/\D/g, "") ?? null;
  const vigencia = fechaIso(extraido.identificacionVigencia);
  if (vigencia && new Date(`${vigencia}T12:00:00Z`).getTime() < Date.now()) advertencias.push(`La identificación está vencida (${vigencia})`);

  bitacora(user, req, {
    companyId,
    accion: "hospital.identificacion.leer",
    entidad: "HospPaciente",
    detalle: { tipo, mime, bytes, confianza, curpValida, rfcValido, advertencias: advertencias.length },
  });

  return NextResponse.json({
    tipo,
    campos: {
      nombres: texto(extraido.nombres, 120),
      apellidoPaterno: texto(extraido.apellidoPaterno, 120),
      apellidoMaterno: texto(extraido.apellidoMaterno, 120),
      curp: curpLeida,
      curpValida,
      rfc: rfcLeido,
      rfcValido,
      fechaNacimiento,
      sexo,
      entidadNacimientoClave: entidadCurp ? (ENTIDAD_DGIS_POR_CURP[entidadCurp] ?? null) : null,
      entidadNacimientoCurp: entidadCurp,
      nacionalidad: texto(extraido.nacionalidad, 3)?.toUpperCase() ?? (curpValida ? (curpLeida!.slice(11, 13) === "NE" ? null : "MEX") : null),
      identificacionTipo: tipo === "OTRO" ? null : tipo,
      identificacionNumero: texto(extraido.identificacionNumero, 40)?.toUpperCase() ?? null,
      identificacionVigencia: vigencia,
      domicilio: {
        calle: texto(dom.calle, 120),
        numeroExterior: texto(dom.numeroExterior, 20),
        numeroInterior: texto(dom.numeroInterior, 20),
        colonia: texto(dom.colonia, 120),
        municipio: texto(dom.municipio, 120),
        estado: texto(dom.estado, 60),
        codigoPostal: codigoPostal && /^\d{5}$/.test(codigoPostal) ? codigoPostal : null,
      },
    },
    confianza,
    advertencias,
  });
});
