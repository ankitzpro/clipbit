/**
 * Per-stream comparative ranking (idea adapted from openshorts' batch "RANK these windows" pass, MIT).
 * Scoring each chunk on its own lets a small model call everything great; seeing every moment of the stream side
 * by side forces a spread. The AI ranks; ClipBit turns its ORDER (not its raw numbers) into rank points, so the
 * spread is guaranteed even if the model clusters its scores. final = 55 % evidence score + 45 % rank.
 */
import { one, q } from '../../db/pool.js';
import { errMsg, logger } from '../../lib/log.js';
import { getSettings } from '../../settings.js';
import { generateJson } from './providers.js';
import type { ScoreBreakdown } from './scoring.js';

const log = logger('ranking');
const BATCH = 25;
const EVIDENCE_SHARE = 0.55;

const schema = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { i: { type: 'INTEGER' }, score: { type: 'INTEGER' }, reason: { type: 'STRING' } },
        required: ['i', 'score'],
      },
    },
  },
  required: ['items'],
};

interface Row {
  id: string; start_sec: number; end_sec: number; title: string; description: string | null; category: string | null;
  transcript: string | null; score: number; score_breakdown: ScoreBreakdown & { preRank?: number };
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function prompt(rows: Row[], context: string) {
  const list = rows.map((r, i) => {
    const e = r.score_breakdown.evidence;
    return `${i}. [${fmt(r.start_sec)}-${fmt(r.end_sec)}] (${r.category || 'other'}) "${r.title}" — ${(r.description || '').slice(0, 220)}`
      + `${r.transcript ? ` | said: "${r.transcript.slice(0, 160)}"` : ''} | checklist event ${e.event} novelty ${e.novelty} payoff ${e.payoff} reaction ${e.reaction}`;
  }).join('\n');
  return `You are a senior short-form video strategist for a ${context} channel.
RANK these candidate moments from ONE stream by how well each would work as a standalone YouTube Short.

Rules:
- Score EVERY moment: exactly one entry per input, with its index "i". Do not drop weak ones — say they are weak.
- "score" is 0-100 and the RANKING is what matters: use the whole range instead of clustering. Most moments of a normal
  stream are not great Shorts, so reserve 70+ for the few that pass the test below, and put routine gameplay,
  driving around, menus and filler conversation under 30.
- THE 2-SECOND TEST is the main criterion: would the first 2 seconds force a viewer with no context to keep watching?
  Moments that only work with context score low.
- Prefer clear events (crashes, chases ending, kills, fails, wins), surprise, strong reactions and a payoff inside the clip.
- "reason": 3-8 words.

MOMENTS:
${list}`;
}

/** Re-rank all evidence-scored moments of a session and update their scores (idempotent: always from preRank). */
export async function rankSession(sessionId: string): Promise<{ ranked: number } | null> {
  const rows = await q<Row>(
    `SELECT id, start_sec, end_sec, title, description, category, transcript, score, score_breakdown FROM moments
      WHERE session_id = $1 AND score_breakdown IS NOT NULL AND status <> 'dismissed' ORDER BY start_sec`,
    [sessionId],
  );
  if (rows.length < 3) return null; // nothing to compare
  const settings = await getSettings();
  const ai = new Map<string, { score: number; reason?: string }>();
  for (let b = 0; b < rows.length; b += BATCH) {
    const batch = rows.slice(b, b + BATCH);
    try {
      const { result } = await generateJson(prompt(batch, settings.contentContext), null, schema, 0.2, settings.aiProvider.detect);
      for (const it of Array.isArray(result?.items) ? result.items : []) {
        const r = batch[Number(it?.i)];
        if (r && Number.isFinite(Number(it.score))) ai.set(r.id, { score: Math.max(0, Math.min(100, Number(it.score))), reason: it.reason ? String(it.reason).slice(0, 80) : undefined });
      }
    } catch (e) {
      log.warn(`ranking batch failed for session ${sessionId}: ${errMsg(e)}`);
    }
  }
  if (ai.size < Math.min(3, rows.length)) return null; // AI unavailable / unusable — keep evidence scores

  const pre = (r: Row) => r.score_breakdown.preRank ?? r.score;
  // order by AI rank score; a moment the AI skipped is placed by its evidence score, ties also fall back to it
  const key = (r: Row) => ai.get(r.id)?.score ?? pre(r);
  const ordered = [...rows].sort((a, b) => key(b) - key(a) || pre(b) - pre(a));
  const n = ordered.length;
  for (const [idx, r] of ordered.entries()) {
    const rankPoints = Math.round(100 * (1 - idx / (n - 1)));
    const final = Math.round(EVIDENCE_SHARE * pre(r) + (1 - EVIDENCE_SHARE) * rankPoints);
    const breakdown = { ...r.score_breakdown, preRank: pre(r), rank: { position: idx + 1, of: n, points: rankPoints, aiScore: ai.get(r.id)?.score, reason: ai.get(r.id)?.reason } };
    await q(`UPDATE moments SET score = $2, score_breakdown = $3 WHERE id = $1`, [r.id, final, JSON.stringify(breakdown)]);
    // keep un-reviewed single clips in sync with their moment
    await q(`UPDATE clips SET score = $2 WHERE moment_id = $1 AND status IN ('queued','rendering','ready','failed')`, [r.id, final]);
  }
  log.info(`ranked ${n} moments of session ${sessionId}`);
  return { ranked: n };
}

/** Called after each analysed chunk: rank when the session has nothing pending (live: every 5th chunk). */
export async function maybeRankSession(sessionId: string, chunkIdx: number, enqueue: (sessionId: string) => Promise<void>) {
  const s = await one<{ active: boolean; pending: number }>(
    `SELECT se.active, (SELECT count(*)::int FROM chunks c WHERE c.session_id = se.id AND c.status IN ('pending','analyzing')) AS pending
       FROM sessions se WHERE se.id = $1`,
    [sessionId],
  );
  if (!s || s.pending > 0) return;
  if (s.active && chunkIdx % 5 !== 4) return; // live: re-rank every ~5 chunks, not after every one
  await enqueue(sessionId);
}
