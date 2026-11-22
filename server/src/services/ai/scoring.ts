/**
 * Evidence-based moment score (0-100). The AI no longer picks the number: it answers a checklist about what it can
 * actually see/hear (0-3 each), ClipBit measures the audio/visual spikes inside the clip window itself, and the
 * owner's own star ratings nudge categories they consistently like or dislike. The result is explainable
 * (score_breakdown) and spreads out: routine driving lands ~10-25, a genuinely great moment 85+.
 */
import { hypeHits } from './signals.js';
import type { Segment, Signals } from './types.js';

export interface Evidence {
  event: number;      // concrete event happens (crash, kill, chase ends, fail, win) — 0 nothing happens
  novelty: number;    // unusual vs normal gameplay — 0 routine driving/walking/menus
  payoff: number;     // result / punchline is inside the clip (not cut off before it)
  reaction: number;   // audible streamer reaction (laugh, shout, surprise)
  standalone: number; // understandable for a stranger with no context
}

export const EVIDENCE_KEYS: (keyof Evidence)[] = ['event', 'novelty', 'payoff', 'reaction', 'standalone'];

// weights sum to 1 together with SIGNAL_WEIGHT
const WEIGHTS: Record<keyof Evidence, number> = { event: 0.28, novelty: 0.22, payoff: 0.15, reaction: 0.12, standalone: 0.08 };
const SIGNAL_WEIGHT = 0.15;

export interface ScoreBreakdown {
  v: 1;
  evidence: Evidence;               // 0-3 each, after sanity checks
  evidencePoints: number;           // 0-85
  signal: number;                   // 0-1 measured strength inside the window
  signalPoints: number;             // 0-15
  base: number;                     // evidencePoints + signalPoints
  taste?: { category: string; avgStars: number; n: number; points: number }; // owner's star-rating adjustment
  audience?: { heat: number; points: number }; // YouTube "Most replayed" heat inside the clip (0..1), when available
  aiGuess?: number;                 // the AI's own 0-100 opinion, kept for comparison only
  notes: string[];                  // human-readable reasons for corrections
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const level = (v: unknown) => clamp(Math.round(Number(v) || 0), 0, 3);

/** 0-1: strongest spike in [start,end] (audio counts fully, visual/speech 80 %) and loudness dynamics. */
export function measuredSignal(signals: Signals | null | undefined, start: number, end: number): { value: number; audioSpike: boolean } {
  if (!signals) return { value: 0, audioSpike: false };
  let peak = 0;
  let audioSpike = false;
  for (const p of signals.peaks || []) {
    if (p.t < start || p.t > end) continue;
    const norm = clamp((p.strength - 1) / 2.5, 0, 1) * (p.kind === 'audio' ? 1 : 0.8);
    peak = Math.max(peak, norm);
    if (p.kind === 'audio' && p.strength >= 1.5) audioSpike = true;
  }
  // loudness dynamics: loud bursts vs the window's typical level (LUFS), 15 dB ⇒ 1.0
  const from = Math.max(0, Math.floor(start - (signals.offset || 0)));
  const to = Math.min((signals.loudness || []).length, Math.ceil(end - (signals.offset || 0)));
  const win = (signals.loudness || []).slice(from, to).filter((x) => Number.isFinite(x) && x > -70).sort((a, b) => a - b);
  let dyn = 0;
  if (win.length >= 5) dyn = clamp((win[Math.floor(win.length * 0.95)] - win[Math.floor(win.length / 2)]) / 15, 0, 1);
  return { value: Math.max(peak, dyn * 0.8), audioSpike };
}

export interface TasteStats { [category: string]: { avgStars: number; n: number } }

/** ±12 points for categories the owner rated consistently (needs ≥3 ratings). 3★ = neutral. */
export function tasteAdjustment(category: string, taste?: TasteStats) {
  const t = taste?.[category];
  if (!t || t.n < 3) return undefined;
  return { category, avgStars: Math.round(t.avgStars * 10) / 10, n: t.n, points: Math.round(clamp((t.avgStars - 3) * 6, -12, 12)) };
}

export function computeScore(args: {
  evidence: Partial<Evidence> | null | undefined;
  signals?: Signals | null;
  transcript?: Segment[];
  start: number; end: number; // session seconds
  category: string;
  aiGuess?: number;
  taste?: TasteStats;
  /** YouTube "Most replayed" graph of the source video, session seconds */
  heatmap?: { s: number; e: number; v: number }[] | null;
}): { score: number; breakdown: ScoreBreakdown } {
  const notes: string[] = [];
  const e: Evidence = { event: 0, novelty: 0, payoff: 0, reaction: 0, standalone: 0 };
  for (const k of EVIDENCE_KEYS) e[k] = level(args.evidence?.[k]);
  if (!args.evidence) notes.push('AI gave no checklist — scored from measured signals only');

  const sig = measuredSignal(args.signals, args.start, args.end);
  const spoken = (args.transcript || []).filter((s) => s.end > args.start && s.start < args.end).map((s) => s.text).join(' ');
  const speech = spoken.trim().length > 2;
  // measured evidence: hype words / exclamations in the transcript ("oh shit!", "bro!", laughing) prove a reaction
  const hype = hypeHits(spoken);
  const heard = hype >= 2 ? 2 : hype >= 1 ? 1 : 0;
  if (heard > e.reaction) {
    notes.push(`reaction raised to ${heard}: excited speech in the transcript`);
    e.reaction = heard;
  }
  // sanity: a strong "reaction" needs something audible — speech in the window or an audio spike
  if (e.reaction >= 2 && !speech && !sig.audioSpike) {
    e.reaction = 1;
    notes.push('reaction lowered: no speech or audio spike in the clip');
  }
  // sanity: "payoff" without any event is not a payoff
  if (e.event === 0 && e.payoff > 1) {
    e.payoff = 1;
    notes.push('payoff lowered: no concrete event');
  }

  const evidencePoints = EVIDENCE_KEYS.reduce((sum, k) => sum + (e[k] / 3) * WEIGHTS[k] * 100, 0);
  const signalPoints = sig.value * SIGNAL_WEIGHT * 100;
  const base = evidencePoints + signalPoints;
  const taste = tasteAdjustment(args.category, args.taste);
  // real audience (idea from openshorts' viewer-clip signal): the most-replayed part of the video earns up to +12
  let audience: ScoreBreakdown["audience"];
  if (args.heatmap?.length) {
    const heat = Math.max(0, ...args.heatmap.filter((h) => h.e > args.start && h.s < args.end).map((h) => clamp(h.v, 0, 1)));
    audience = { heat: Math.round(heat * 100) / 100, points: Math.round(heat * 12) };
  }
  const score = Math.round(clamp(base + (taste?.points || 0) + (audience?.points || 0), 0, 100));
  return {
    score,
    breakdown: {
      v: 1, evidence: e, evidencePoints: Math.round(evidencePoints), signal: Math.round(sig.value * 100) / 100,
      signalPoints: Math.round(signalPoints), base: Math.round(base), taste, audience,
      aiGuess: Number.isFinite(args.aiGuess) ? Math.round(args.aiGuess as number) : undefined, notes,
    },
  };
}
