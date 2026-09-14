/**
 * POST /api/hospital/cobros/leer { companyId, archivoBase64, mime }
 *   → { voucher: {...}, afiliacionId, propuestas: [...], firme, advertencias[] }
 *
 * Lee la foto de un voucher de terminal y propone contra qué factura va, para
 * que la cajera confirme con un toque en vez de teclear.
 *
 * POR QUÉ EN LA CAJA Y NO EN LA CONCILIACIÓN. El estado de cuenta sólo dice
 * «HOSP HALTUS 09992889D $47,669.88» —un lote de varias ventas del día— y no
 * hay forma de repartirlo después: agosto se reconstruyó a mano en un Excel y
 * aun así tres conciliaciones salieron mal, entre ellas un traspaso cobrado a
 * la factura de un paciente. El dato de a QUIÉN corresponde cada deslizada
 * existe un solo momento: cuando la persona está enfrente con el voucher en la
 * mano. Ahí cuesta una foto.
 *
 * NO ESCRIBE NADA. Devuelve la lectura y las propuestas; el alta la hace
 * POST /api/hospital/cobros, que ya valida el voucher y rechaza duplicados.
 * La imagen no se guarda aquí (va como documento del episodio) y se manda a la
 * API de Anthropic de forma efímera, con el gasto medido y acotado por la
 * guardia de IA de la empresa — mismo trato que la lectura de identificaciones.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { requireModule, requireWriter } from "@/lib/authz";
import { meteredCreate } from "@/lib/costos/anthropic";
import { asegurarUsoIA, respuestaTopeIA } from "@/lib/ai/guardia";
import { withHospital } from "@/lib/hospital/with-hospital";
import { bitacora, error, errorZod } from "@/lib/hospital/http";
import { MARCAS, TIPOS_TARJETA, normalizarAutorizacion, normalizarUltimos4 } from "@/lib/hospital/cobros";
import { esPropuestaFirme, proponerFacturas, type CandidatoFactura, type VoucherLeido } from "@/lib/hospital/voucher";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BYTES = 10 * 1024 * 1024;
const MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
/** Ventana de facturas candidatas alrededor de la fecha del voucher. */
const DIAS_VENTANA = 60;

const schema = z.object({
  companyId: z.string().min(1),
  archivoBase64: z.string().min(1),
  mime: z.enum(MIMES),
});

const SYSTEM_PROMPT = `Eres un asistente de caja de un hospital en México. Extraes los datos de un COMPROBANTE DE PAGO CON TARJETA (voucher de terminal punto de venta) para registrar el cobro.

REGLAS:
1. Devuelve SOLO un objeto JSON válido, sin markdown ni explicaciones.
2. Si un campo no aparece con claridad, devuelve null. NO inventes ni completes valores.
3. monto: el IMPORTE TOTAL de la operación, como número sin signo de pesos ni comas. Si el voucher trae propina, devuelve el total final.
4. fecha: la fecha de la OPERACIÓN impresa en el voucher, en formato AAAA-MM-DD.
5. afiliacion: el número de AFILIACIÓN del comercio (aparece como AFILIACION, AFIL, MERCHANT ID o MID). Suele tener 7 a 10 dígitos. Sólo los dígitos.
6. autorizacion: el número de AUTORIZACION (AUT, AUTH, COD. AUT). Suele tener 6 dígitos.
7. ultimos4: los ÚLTIMOS 4 DÍGITOS de la tarjeta (el voucher enmascara el resto con asteriscos o X).
8. marca: VISA, MASTERCARD, AMEX, CARNET u OTRA.
9. tipoTarjeta: CREDITO o DEBITO, según lo que diga el voucher.
10. tarjetahabiente: el nombre impreso del titular de la tarjeta, tal cual (suele venir «APELLIDOS/NOMBRE»). Si no aparece, null.
11. operacion: "VENTA", "DEVOLUCION", "CANCELACION" u otra si el voucher lo indica.
12. confianza: número entre 0 y 1 según la legibilidad del ticket.

SCHEMA DE RESPUESTA (exactamente estos campos):
{
  "monto": number | null,
  "fecha": string | null,
  "afiliacion": string | null,
  "autorizacion": string | null,
  "ultimos4": string | null,
  "marca": "VISA" | "MASTERCARD" | "AMEX" | "CARNET" | "OTRA" | null,
  "tipoTarjeta": "CREDITO" | "DEBITO" | null,
  "tarjetahabiente": string | null,
  "operacion": string | null,
  "confianza": number,
  "notas": string | null
}
Usa "notas" (español, 1-2 líneas) si el ticket está borroso, cortado, o no parece un voucher de terminal.`;

type Extraido = Partial<Record<keyof VoucherLeido | "operacion" | "notas", unknown>> & { confianza?: unknown };

const texto = (v: unknown, max = 120): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const digitos = (v: unknown, max = 20): string | null => {
  const s = texto(v, max)?.replace(/\D/g, "") ?? "";
  return s || null;
};

/** «1,234.50», «$1234.50» o 1234.5 → 1234.5; basura → null. */
function importe(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  const s = texto(v, 30);
  if (!s) return null;
  const n = Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** AAAA-MM-DD válido, o null. No se adivina el año de una fecha de dos dígitos. */
function fechaIso(v: unknown): string | null {
  const s = texto(v, 20);
  const m = s && /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
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
  if (!process.env.ANTHROPIC_API_KEY) return error("La lectura de vouchers con IA no está configurada en este servidor", 503);

  const base64 = parsed.data.archivoBase64.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return error("archivoBase64 no es base64 válido");
  const bytes = Math.floor((base64.length * 3) / 4);
  if (bytes > MAX_BYTES) return error(`La foto pesa ${(bytes / 1048576).toFixed(1)} MB; el máximo es 10 MB`, 413);

  let respuesta = "";
  try {
    const anthropic = new Anthropic();
    const msg = await meteredCreate(anthropic, { subtipo: "hospital.voucher.leer", userId: user.id, companyId }, {
      model: "claude-opus-5",
      max_tokens: 1024,
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: base64 } },
            { type: "text", text: "Extrae los datos de este voucher siguiendo el schema exacto. Sólo JSON." },
          ],
        },
      ],
    });
    if (msg.stop_reason === "refusal") return error("El modelo no procesó la foto; captura el voucher a mano", 422);
    respuesta = msg.content.find((b) => b.type === "text")?.text ?? "";
  } catch (e) {
    console.error("[hospital.voucher.leer] error del modelo:", e instanceof Error ? e.message : e);
    return error("No se pudo leer el voucher; captura los datos a mano", 502);
  }

  let extraido: Extraido;
  try {
    extraido = JSON.parse(respuesta.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim());
  } catch {
    return error("La lectura no devolvió datos legibles; captura los datos a mano", 502);
  }
  if (!extraido || typeof extraido !== "object") return error("La lectura no devolvió datos legibles; captura los datos a mano", 502);

  const advertencias: string[] = [];
  const nota = texto(extraido.notas, 300);
  if (nota) advertencias.push(nota);

  const marcaLeida = texto(extraido.marca, 20)?.toUpperCase() ?? null;
  const tipoLeido = texto(extraido.tipoTarjeta, 20)?.toUpperCase() ?? null;
  const voucher: VoucherLeido = {
    monto: importe(extraido.monto),
    fecha: fechaIso(extraido.fecha),
    afiliacion: digitos(extraido.afiliacion, 20),
    // Se normalizan con las MISMAS funciones que usa el alta: si el alta va a
    // rechazar una autorización, más vale que la lectura ya la muestre igual.
    autorizacion: normalizarAutorizacion(extraido.autorizacion) || null,
    ultimos4: normalizarUltimos4(extraido.ultimos4) || null,
    marca: (MARCAS as readonly string[]).includes(marcaLeida ?? "") ? (marcaLeida as VoucherLeido["marca"]) : null,
    tipoTarjeta: (TIPOS_TARJETA as readonly string[]).includes(tipoLeido ?? "") ? (tipoLeido as VoucherLeido["tipoTarjeta"]) : null,
    tarjetahabiente: texto(extraido.tarjetahabiente, 120),
  };

  if (!voucher.monto) advertencias.push("No se leyó el importe: captúralo antes de guardar.");
  if (!voucher.fecha) advertencias.push("No se leyó la fecha de operación: se usará la de hoy si no la corriges.");
  const operacion = texto(extraido.operacion, 30)?.toUpperCase() ?? null;
  if (operacion && operacion !== "VENTA") advertencias.push(`El voucher dice «${operacion}», no una venta: revísalo antes de registrarlo como cobro.`);

  // La afiliación leída se amarra a la que la empresa tiene dada de alta; si no
  // está, se dice — sin afiliación el cobro no se puede casar con el depósito.
  let afiliacionId: string | null = null;
  if (voucher.afiliacion) {
    const af = await prisma.hospAfiliacion.findFirst({
      where: { companyId, activa: true, numero: { contains: voucher.afiliacion } },
      select: { id: true, numero: true },
    });
    if (af) afiliacionId = af.id;
    else advertencias.push(`La afiliación ${voucher.afiliacion} no está dada de alta en el hospital.`);
  } else {
    advertencias.push("No se leyó la afiliación de la terminal: sin ella el cobro no se podrá casar con el depósito del adquirente.");
  }

  // ── Contra qué factura podría ir ──────────────────────────────────────────
  const centro = voucher.fecha ? new Date(`${voucher.fecha}T12:00:00Z`) : new Date();
  const desde = new Date(centro.getTime() - DIAS_VENTANA * 86_400_000);
  const hasta = new Date(centro.getTime() + 86_400_000);
  const facturas = await prisma.invoice.findMany({
    where: { companyId, tipo: "INGRESO", status: "STAMPED", fecha: { gte: desde, lt: hasta } },
    select: {
      id: true, folio: true, uuid: true, total: true, fecha: true,
      contraparteNombre: true, contraparteRfc: true,
      customer: { select: { razonSocial: true, rfc: true } },
      bankTransactions: { where: { status: "MATCHED" }, select: { monto: true } },
      conciliacionDetalles: { select: { montoAsignado: true } },
      hospCobros: { where: { estado: { in: ["COBRADO", "DEPOSITADO", "RECUPERADO"] } }, select: { monto: true } },
    },
    take: 400,
  });

  const candidatos: CandidatoFactura[] = facturas.map((f) => ({
    invoiceId: f.id,
    folio: f.folio,
    uuid: f.uuid,
    total: Number(f.total),
    // Lo ya cobrado cuenta el banco Y los cobros de caja: si no, el mismo
    // voucher se propondría otra vez contra una factura que ya se pagó aquí.
    cobrado:
      f.bankTransactions.reduce((s, t) => s + Math.abs(Number(t.monto)), 0) +
      f.conciliacionDetalles.reduce((s, d) => s + Math.abs(Number(d.montoAsignado)), 0) +
      f.hospCobros.reduce((s, c) => s + Math.abs(Number(c.monto)), 0),
    fecha: f.fecha.toISOString().slice(0, 10),
    receptorNombre: f.customer?.razonSocial ?? f.contraparteNombre,
    receptorRfc: f.customer?.rfc ?? f.contraparteRfc,
  }));

  const propuestas = proponerFacturas(voucher, candidatos).slice(0, 8);
  if (propuestas.length === 0 && voucher.monto) {
    advertencias.push("Ninguna factura abierta cuadra con este voucher: elige el episodio o la factura a mano.");
  }

  bitacora(user, req, { companyId, accion: "hospital.cobro.leer", detalle: `Voucher leído · ${voucher.monto ?? "sin importe"} · ${propuestas.length} propuesta(s)` });

  return NextResponse.json({
    voucher,
    afiliacionId,
    propuestas,
    firme: esPropuestaFirme(propuestas),
    confianza: typeof extraido.confianza === "number" ? extraido.confianza : null,
    advertencias,
  });
});
