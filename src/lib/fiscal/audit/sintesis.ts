// ─────────────────────────────────────────────────────────────────────────────
// Síntesis EJECUTIVA del auditor.
//
// Los checks son deterministas a propósito (cada hallazgo con fundamento y
// dedupe), pero su salida es granular: uno por CFDI, por par duplicado, por
// mes faltante. Con cientos de renglones abiertos, la lista deja de informar —
// reporte textual del operador: "producen cientos de cosas, muy messy".
//
// La síntesis NO reemplaza a los checks ni decide nada fiscal: los AGRUPA por
// causa raíz (checkClave) con código determinista, y Claude escribe la lectura
// priorizada — qué atender primero, qué se arregla en lote con una sola
// acción, qué puede esperar. Mismo contrato que el memo de crédito: la
// narrativa es best-effort (si Claude falla, los grupos deterministas quedan),
// y el costo se registra por empresa.
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { recordLlmCost } from "@/lib/costos/record";

let _anthropic: Anthropic | null = null;
const anthropic = () => (_anthropic ??= new Anthropic());

export interface HallazgoParaSintesis {
  checkClave: string;
  severidad: string; // "error" | "warn" | "info"
  mensaje: string;
  sugerencia: string;
  fundamentoLey: string;
  fundamentoArticulo: string;
}

export interface GrupoHallazgos {
  clave: string;
  severidad: string;
  n: number;
  fundamento: string;
  /** Sugerencia representativa del grupo (la de su primer hallazgo). */
  accion: string;
  /** Hasta 5 mensajes de muestra — el resto es "y N más como éstos". */
  ejemplos: string[];
}

const ORDEN_SEV: Record<string, number> = { error: 0, warn: 1, info: 2 };

/**
 * Agrupa hallazgos abiertos por causa raíz (checkClave). Determinista y PURA:
 * es la estructura que la UI pinta aunque la narrativa de IA falle. Orden:
 * severidad del grupo (error primero) y luego tamaño.
 */
export function agruparHallazgos(hallazgos: HallazgoParaSintesis[]): GrupoHallazgos[] {
  const porClave = new Map<string, HallazgoParaSintesis[]>();
  for (const h of hallazgos) {
    (porClave.get(h.checkClave) ?? porClave.set(h.checkClave, []).get(h.checkClave)!).push(h);
  }
  return [...porClave.entries()]
    .map(([clave, hs]) => {
      const sev = hs.reduce(
        (peor, h) => (ORDEN_SEV[h.severidad] < ORDEN_SEV[peor] ? h.severidad : peor),
        "info",
      );
      return {
        clave,
        severidad: sev,
        n: hs.length,
        fundamento: `${hs[0].fundamentoLey} ${hs[0].fundamentoArticulo}`,
        accion: hs[0].sugerencia,
        ejemplos: hs.slice(0, 5).map((h) => h.mensaje),
      };
    })
    .sort((a, b) => ORDEN_SEV[a.severidad] - ORDEN_SEV[b.severidad] || b.n - a.n);
}

const SYSTEM = `Eres el auditor fiscal senior de un despacho mexicano. Recibes los hallazgos ABIERTOS del auditor automático de UNA empresa, ya agrupados por causa raíz, y escribes la lectura ejecutiva para el contador que la atiende.

Reglas estrictas:
- SOLO usa los datos que te doy. No inventes montos, conteos ni fundamentos.
- Los montos que cites deben venir textuales de los ejemplos.
- Piensa en ACCIONES, no en listas: si un grupo de 40 hallazgos se resuelve con una sola acción (p. ej. activar una regla, subir un estado de cuenta, corregir un método de pago recurrente), dilo así.
- Estructura EXACTA (encabezados en negritas markdown):
**Atiende primero** (máx. 3 puntos: el riesgo/monto más grande, con el porqué en una línea)
**Se arregla en lote** (grupos que caen con UNA acción; di cuál)
**Puede esperar** (una línea que agrupe lo menor; no lo enumeres)
- Máximo 220 palabras. Sin preámbulos ni despedidas. Español.`;

/**
 * Genera (o regenera) el brief de auditoría de la empresa. Llamar cuando la
 * corrida CAMBIÓ algo (nuevos > 0 o autoResueltos > 0) o no hay brief — el
 * gate vive en el llamador para que una corrida sin cambios no gaste tokens.
 */
export async function generarSintesisAuditoria(companyId: string): Promise<{
  grupos: GrupoHallazgos[];
  resumen: string | null;
}> {
  const [company, abiertos] = await Promise.all([
    prisma.company.findUnique({
      where: { id: companyId },
      select: { razonSocial: true, rfc: true, regimenFiscal: true },
    }),
    prisma.fiscalHallazgo.findMany({
      where: {
        companyId,
        estado: "ABIERTO",
        // Lo pospuesto está silenciado a propósito: no debe re-aparecer aquí.
        OR: [{ posponerHasta: null }, { posponerHasta: { lte: new Date() } }],
      },
      select: {
        checkClave: true,
        severidad: true,
        mensaje: true,
        sugerencia: true,
        fundamentoLey: true,
        fundamentoArticulo: true,
      },
    }),
  ]);
  if (!company) throw new Error(`Company ${companyId} not found`);

  const grupos = agruparHallazgos(abiertos);

  // Sin pendientes: brief limpio, sin gastar un token.
  if (grupos.length === 0) {
    await prisma.auditBrief.upsert({
      where: { companyId },
      create: { companyId, resumen: "Sin hallazgos abiertos. Todo en orden.", grupos: [], hallazgosAbiertos: 0 },
      update: { resumen: "Sin hallazgos abiertos. Todo en orden.", grupos: [], hallazgosAbiertos: 0 },
    });
    return { grupos, resumen: null };
  }

  // Narrativa (best-effort): si Claude falla, los grupos deterministas quedan.
  let resumen: string | null = null;
  try {
    const model = "claude-sonnet-4-5";
    const response = await anthropic().messages.create({
      model,
      max_tokens: 700,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Empresa: ${company.razonSocial} (${company.rfc}, régimen ${company.regimenFiscal}). ${abiertos.length} hallazgo(s) abiertos en ${grupos.length} grupo(s):\n\n${JSON.stringify(grupos, null, 2)}`,
        },
      ],
    });
    void recordLlmCost(response.model ?? model, response.usage, {
      companyId,
      subtipo: "llm.audit_sintesis",
    });
    const texto = response.content.find((b) => b.type === "text");
    resumen = texto && texto.type === "text" ? texto.text.trim() : null;
  } catch (e) {
    console.error("[audit/sintesis] narrativa falló (los grupos quedan):", e instanceof Error ? e.message : e);
  }

  await prisma.auditBrief.upsert({
    where: { companyId },
    create: {
      companyId,
      resumen: resumen ?? "",
      grupos: JSON.parse(JSON.stringify(grupos)),
      hallazgosAbiertos: abiertos.length,
    },
    update: {
      resumen: resumen ?? "",
      grupos: JSON.parse(JSON.stringify(grupos)),
      hallazgosAbiertos: abiertos.length,
      generadoAt: new Date(),
    },
  });

  return { grupos, resumen };
}
