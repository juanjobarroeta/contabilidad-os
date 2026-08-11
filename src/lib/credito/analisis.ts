// ─────────────────────────────────────────────────────────────────────────────
// Memo de análisis de crédito generado por IA — la lectura NARRATIVA que el
// scorecard numérico no da: modelo de negocio (¿por qué factura menos de lo
// que declara?), fortalezas, riesgos con mitigantes y recomendación con
// condiciones. Se genera AL EVALUAR y se guarda en el snapshot inmutable:
// meses después se lee exactamente el análisis que respaldó la decisión.
//
// Best-effort: si Claude falla, la evaluación se guarda sin memo (el score
// numérico nunca depende de la IA).
// ─────────────────────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import { recordLlmCost } from "@/lib/costos/record";
import type { InsumosCredito, ResultadoScore } from "./score";

let _anthropic: Anthropic | null = null;
const anthropic = () => (_anthropic ??= new Anthropic());

const SYSTEM = `Eres un analista de crédito senior especializado en PyMEs mexicanas. Escribes memos de crédito internos, en español, sobrios y accionables, para el comité de un prestamista.

Reglas estrictas:
- SOLO usa los datos que te doy. No inventes cifras, clientes ni hechos.
- Si un dato falta, dilo como limitación, no lo rellenes.
- Interpreta el CONTEXTO fiscal mexicano correctamente. En particular: declarar MÁS de lo que se factura es patrón normal de venta a público en general (efectivo declarado sin CFDI individual) — no es señal de fraude. Lo sospechoso es lo inverso. RESICO PF paga ISR sobre ingreso bruto sin deducciones y no presenta anual.
- Estructura EXACTA (encabezados en negritas markdown):
**Perfil del negocio** (2-3 líneas: qué se infiere del giro, volumen y clientes)
**Fortalezas** (viñetas)
**Riesgos y mitigantes** (viñetas: riesgo → mitigante o condición)
**Lectura del flujo** (2-3 líneas: capacidad de pago real)
**Recomendación** (límite, plazo sugerido y condiciones concretas)
- Máximo 350 palabras. Sin preámbulos ni despedidas.`;

export async function generarAnalisisCredito(args: {
  razonSocial: string;
  rfc: string;
  regimenFiscal: string | null;
  resultado: ResultadoScore;
  insumos: InsumosCredito;
  companyId: string;
}): Promise<string | null> {
  const { resultado, insumos } = args;

  // Resumen compacto de insumos (sin PDFs ni series completas — lo que un
  // analista pondría en la primera hoja).
  const resumen = {
    empresa: { razonSocial: args.razonSocial, rfc: args.rfc, regimenFiscal: args.regimenFiscal },
    score: { valor: resultado.score, banda: resultado.banda, limiteSugerido: resultado.limiteSugerido, provisional: resultado.provisional },
    dimensiones: resultado.dimensiones.map((d) => ({ etiqueta: d.etiqueta, peso: d.peso, puntos: d.puntos, razones: d.razones })),
    coberturaFaltante: resultado.cobertura,
    mesesDeclarados: insumos.declaraciones.length,
    gastosFacturados12m: insumos.gastosFacturados12m,
    nominaTimbrada12m: insumos.nomina12m,
    flujosBancarios: insumos.bancos,
    // Cartera PPD/REP: cobranza (cómo le pagan) y pagos (cómo paga) — el
    // comportamiento de pago observable, clave para el memo.
    carteraPPD: insumos.flujosPPD,
  };

  try {
    const model = "claude-sonnet-4-5";
    const response = await anthropic().messages.create({
      model,
      max_tokens: 1200,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Redacta el memo de crédito para este expediente:\n\n${JSON.stringify(resumen, null, 2)}`,
        },
      ],
    });
    void recordLlmCost(response.model ?? model, response.usage, {
      companyId: args.companyId,
      subtipo: "llm.credito_analisis",
    });
    const texto = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    return texto || null;
  } catch (e) {
    console.error("[credito/analisis] fallo al generar memo:", e instanceof Error ? e.message : e);
    return null;
  }
}
