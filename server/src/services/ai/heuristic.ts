/**
 * Key-free fallback detector: ranks moments from loudness spikes, visual action and hype words.
 * Used when no GEMINI_API_KEY is configured, or if the Gemini call fails.
 */
import { refineBoundaries, transcriptText, fmtTime, type BoundaryOpts } from './boundaries.js';
import { hypeHits } from './signals.js';
import type { LearningProfile, MomentCandidate, Segment, Signals } from './types.js';

export function heuristicMoments(
  signals: Signals,
  transcript: Segment[],
  opts: BoundaryOpts & { maxMoments: number; defaultHashtags: string[]; learning?: LearningProfile },
): MomentCandidate[] {
  const out: MomentCandidate[] = [];
  for (const p of signals.peaks) {
    if (out.length >= opts.maxMoments) break;
    const { start, end } = refineBoundaries(p.t - 9, p.t + 6, p.t, transcript, opts);
    if (out.some((m) => overlap(m.start, m.end, start, end) > 0.4)) continue;

    const text = transcriptText(transcript, start, end);
    const near = transcriptText(transcript, p.t - 3, p.t + 3);
    const laugh = /\b(ha){2,}|lol|lmao|funny\b/i.test(text);
    const category = laugh ? 'funny' : p.kind === 'speech' ? 'reaction' : p.kind === 'visual' ? 'action' : hypeHits(near) > 0 ? 'reaction' : 'action';

    let score = Math.round(Math.min(92, 38 + p.strength * 11 + Math.min(10, hypeHits(text) * 3)));
    const cat = opts.learning?.categoryApproval[category];
    if (cat && cat.approved + cat.rejected >= 5) score = Math.round(score * (0.8 + 0.4 * cat.rate));

    const quote = pickQuote(near || text);
    out.push({
      start,
      end,
      peak: p.t,
      title: quote ? `"${quote}" 😳` : category === 'funny' ? `This had chat dying 😂` : `Wild moment at ${fmtTime(p.t)} 🔥`,
      description:
        `Detected from a ${p.kind === 'audio' ? 'sudden volume spike' : p.kind === 'visual' ? 'burst of on-screen action' : 'spike in excited commentary'}` +
        (quote ? ` — "${quote}"` : '') + '.',
      category,
      score: Math.max(0, Math.min(100, score)),
      hashtags: opts.defaultHashtags,
      keywords: quote ? quote.split(/\s+/).filter((w) => w.length > 3).slice(0, 3) : [],
      transcript: text,
      detector: 'heuristic',
    });
  }
  return out;
}

function pickQuote(text: string) {
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const best = sentences.sort((a, b) => hypeHits(b) - hypeHits(a))[0];
  if (!best) return '';
  return best.length > 60 ? best.slice(0, 57).replace(/\s+\S*$/, '') + '…' : best.replace(/[.]$/, '');
}

export function overlap(a0: number, a1: number, b0: number, b1: number) {
  const inter = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  return inter / Math.max(0.001, Math.min(a1 - a0, b1 - b0));
}
