import { prisma } from "@/lib/prisma";
import { lunesDeLaSemana, telegramConfigured } from "./config";
import { listProjectItems, setProjectNumberField, type ProjectItem } from "./github";
import { tgApi } from "./telegram";

// ─────────────────────────────────────────────────────────────────────────────
// Agente de scoring semanal (lunes 06:00 MX).
//
//   score = ((mrr_at_risk + mrr_unlocked) * confidence / effort_days) * core
//
// El `core_multiplier` (×3 si cae en el motor compartido) es el punto de toda
// la fórmula: empuja sistemáticamente el trabajo del motor por encima del de
// los satélites — la tesis de la arquitectura, y lo primero que se erosiona
// bajo presión de clientes, porque los pedidos satélite vienen de humanos con
// nombre y el trabajo core no lo pide nadie.
//
// El scoring PROPONE (escribe el campo Score y manda el digest); el humano
// dispone. Nunca toca Status.
// ─────────────────────────────────────────────────────────────────────────────

export type ScoreInputs = {
  mrrAtRisk: number;
  mrrUnlocked: number;
  /** Creencia 0–1 de que la estimación es real. */
  confidence: number;
  effortDays: number;
  core: boolean;
};

export const CORE_MULTIPLIER = 3.0;

/** Fórmula de score. Pura y testeada. Effort se acota a ≥0.5 días. */
export function computeScore(i: ScoreInputs): number {
  const effort = Math.max(0.5, i.effortDays);
  const confidence = Math.min(1, Math.max(0, i.confidence));
  const base = ((i.mrrAtRisk + i.mrrUnlocked) * confidence) / effort;
  return Math.round(base * (i.core ? CORE_MULTIPLIER : 1.0) * 100) / 100;
}

/** Nombres de campo esperados en el tablero Projects v2 (ver docs/INTAKE.md). */
export const FIELD_NAMES = {
  score: "Score",
  effort: "Effort (days)",
  mrrAtRisk: "MRR at risk",
  mrrUnlocked: "MRR unlocked",
  confidence: "Confidence",
  core: "Core?",
} as const;

function num(v: number | string | boolean | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Extrae los inputs de score de los campos de un item del tablero. Puro. */
export function scoreInputsFromItem(item: ProjectItem): ScoreInputs {
  const f = item.fields;
  const coreRaw = f[FIELD_NAMES.core];
  return {
    mrrAtRisk: num(f[FIELD_NAMES.mrrAtRisk]),
    mrrUnlocked: num(f[FIELD_NAMES.mrrUnlocked]),
    confidence: typeof f[FIELD_NAMES.confidence] === "number" ? (f[FIELD_NAMES.confidence] as number) : 0.5,
    effortDays: num(f[FIELD_NAMES.effort]) || 1,
    core: coreRaw === true || String(coreRaw ?? "").toLowerCase() === "yes" || String(coreRaw ?? "").toLowerCase() === "true",
  };
}

export type ScoredItem = { item: ProjectItem; score: number };

/** Línea del digest con el movimiento vs. la semana anterior. Pura y testeada. */
export function renderMovement(rank: number, title: string, score: number, prevRank: number | null): string {
  let mov: string;
  if (prevRank == null) mov = "🆕";
  else if (prevRank > rank) mov = `▲${prevRank - rank}`;
  else if (prevRank < rank) mov = `▼${rank - prevRank}`;
  else mov = "＝";
  return `${rank}. [${mov}] ${title} — ${score}`;
}

/**
 * Corrida semanal: lee el tablero, calcula score por issue abierto, escribe el
 * campo Score (si INTAKE_GITHUB_SCORE_FIELD_ID está configurado), guarda el
 * snapshot y manda el digest de lunes con el top 10 y qué se movió.
 */
export async function runWeeklyScoring(now = new Date()): Promise<{
  scored: number;
  snapshot: boolean;
  digestSent: boolean;
  skipped?: string;
}> {
  if (!process.env.INTAKE_GITHUB_PROJECT_ID) {
    return { scored: 0, snapshot: false, digestSent: false, skipped: "INTAKE_GITHUB_PROJECT_ID no configurado" };
  }
  const weekOf = lunesDeLaSemana(now);

  // Idempotencia semanal: si esta semana ya tiene snapshot, la corrida fue.
  const yaCorrio = await prisma.intakeScoreSnapshot.findFirst({ where: { weekOf }, select: { id: true } });
  if (yaCorrio) return { scored: 0, snapshot: false, digestSent: false, skipped: "ya corrió esta semana" };

  const items = (await listProjectItems()).filter((i) => i.issueNodeId && i.state === "OPEN");
  const scored: ScoredItem[] = items
    .map((item) => ({ item, score: computeScore(scoreInputsFromItem(item)) }))
    .sort((a, b) => b.score - a.score);

  const scoreFieldId = process.env.INTAKE_GITHUB_SCORE_FIELD_ID;
  if (scoreFieldId) {
    for (const s of scored) {
      try {
        await setProjectNumberField(s.item.itemId, scoreFieldId, s.score);
      } catch (e) {
        console.error("[intake] setProjectNumberField failed", s.item.title, e instanceof Error ? e.message : e);
      }
    }
  }

  // Snapshot de la semana (para el "qué se movió" de la próxima).
  await prisma.intakeScoreSnapshot.createMany({
    data: scored.map((s, idx) => ({
      weekOf,
      issueNodeId: s.item.issueNodeId!,
      issueUrl: s.item.issueUrl,
      title: s.item.title,
      score: s.score,
      rank: idx + 1,
    })),
  });

  // Ranks de la semana pasada, para el movimiento.
  const previa = await prisma.intakeScoreSnapshot.findMany({
    where: { weekOf: { lt: weekOf } },
    orderBy: { weekOf: "desc" },
    take: 200,
  });
  const semanaPrevia = previa.length ? previa.filter((p) => p.weekOf.getTime() === previa[0].weekOf.getTime()) : [];
  const prevRank = new Map(semanaPrevia.map((p) => [p.issueNodeId, p.rank]));

  let digestSent = false;
  if (telegramConfigured() && scored.length > 0) {
    const top = scored.slice(0, 10).map((s, idx) =>
      renderMovement(idx + 1, s.item.title.slice(0, 70), s.score, prevRank.get(s.item.issueNodeId!) ?? null)
    );
    await tgApi("sendMessage", {
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: [`📊 *Prioridades de la semana* (${scored.length} issues abiertos)`, "", ...top, "", "El scoring propone; tú dispones. Ajusta Effort/MRR en el tablero si algo se ve mal."].join("\n"),
      parse_mode: "Markdown",
    });
    digestSent = true;
  }

  return { scored: scored.length, snapshot: true, digestSent };
}
